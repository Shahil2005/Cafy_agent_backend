import {
    getCalComApiBaseForHost,
    getCalApiVersion,
    getCalComApiKey,
    getCalSlotsApiVersion,
} from './config';
import { readSlotsCache, slotsCacheKey, writeSlotsCache } from './slotsCache';
import type { BookableMentor, CalComBookingResult, CounsellingSlot, DurationMinutes } from './types';

/** List bookings endpoint (newer than slots/book create). */
const CAL_BOOKINGS_LIST_API_VERSION = '2026-05-01';

export class CalComBookingError extends Error {
    readonly status: number;
    readonly body: string;

    constructor(message: string, status: number, body: string) {
        super(message);
        this.name = 'CalComBookingError';
        this.status = status;
        this.body = body;
    }

    isDuplicateOrConflict(): boolean {
        const text = this.body.toLowerCase();
        return (
            text.includes('already has booking') ||
            text.includes('already booked') ||
            text.includes('not available')
        );
    }
}

type CalSlotRange = { start: string; end?: string };

function calHeaders(apiVersion = getCalApiVersion()): Record<string, string> {
    return {
        Authorization: `Bearer ${getCalComApiKey()}`,
        'cal-api-version': apiVersion,
        Accept: 'application/json',
    };
}

function formatCalDateRange(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function parseSlotsPayload(payload: unknown): CounsellingSlot[] {
    const slots: CounsellingSlot[] = [];

    if (!payload || typeof payload !== 'object') return slots;

    const root = payload as Record<string, unknown>;
    const data = root.data ?? root;

    if (!data || typeof data !== 'object') return slots;

    const byDate = data as Record<string, unknown>;

    for (const value of Object.values(byDate)) {
        if (!Array.isArray(value)) continue;

        for (const entry of value) {
            if (typeof entry === 'string') {
                slots.push({ startsAt: entry, endsAt: entry });
                continue;
            }
            if (!entry || typeof entry !== 'object') continue;

            const range = entry as CalSlotRange;
            if (typeof range.start === 'string') {
                slots.push({
                    startsAt: range.start,
                    endsAt: typeof range.end === 'string' ? range.end : range.start,
                });
            }
        }
    }

    return slots;
}

export async function fetchCalComSlots(
    mentor: BookableMentor,
    durationMinutes: DurationMinutes,
    startTime: Date,
    endTime: Date
): Promise<CounsellingSlot[]> {
    const eventSlug = mentor.eventSlugForDuration(durationMinutes);
    if (!eventSlug) {
        throw new Error('MENTOR_EVENT_NOT_CONFIGURED');
    }

    const cacheKey = slotsCacheKey(mentor.id, durationMinutes, startTime, endTime);
    const cached = readSlotsCache(cacheKey);
    if (cached) {
        return cached;
    }

    const base = getCalComApiBaseForHost(mentor.calHost);
    const url = new URL(`${base}/slots`);
    url.searchParams.set('username', mentor.calUsername);
    url.searchParams.set('eventTypeSlug', eventSlug);
    url.searchParams.set('start', formatCalDateRange(startTime));
    url.searchParams.set('end', formatCalDateRange(endTime));
    url.searchParams.set('format', 'range');
    url.searchParams.set('timeZone', mentor.calTimezone);

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: calHeaders(getCalSlotsApiVersion()),
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.error('[calcom] slots error', response.status, body.slice(0, 500));
        throw new Error('CALCOM_SLOTS_FAILED');
    }

    const json = (await response.json()) as unknown;
    const slots = parseSlotsPayload(json);
    writeSlotsCache(cacheKey, slots);
    return slots;
}

export async function createCalComBooking(input: {
    mentor: BookableMentor;
    durationMinutes: DurationMinutes;
    slotStartsAt: string;
    attendeeName: string;
    attendeeEmail: string;
    attendeeTimeZone: string;
    goal?: string;
}): Promise<CalComBookingResult> {
    const eventSlug = input.mentor.eventSlugForDuration(input.durationMinutes);
    if (!eventSlug) {
        throw new Error('MENTOR_EVENT_NOT_CONFIGURED');
    }

    const base = getCalComApiBaseForHost(input.mentor.calHost);
    const startUtc = new Date(input.slotStartsAt).toISOString();
    const goal = input.goal?.trim();

    const response = await fetch(`${base}/bookings`, {
        method: 'POST',
        headers: {
            ...calHeaders(),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            eventTypeSlug: eventSlug,
            username: input.mentor.calUsername,
            start: startUtc,
            attendee: {
                name: input.attendeeName,
                email: input.attendeeEmail,
                timeZone: input.attendeeTimeZone,
            },
            ...(goal
                ? {
                      metadata: { cafyGoal: goal },
                      bookingFieldsResponses: { notes: goal },
                  }
                : {}),
        }),
        signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.error('[calcom] booking error', response.status, body.slice(0, 500));
        throw new CalComBookingError('CALCOM_BOOKING_FAILED', response.status, body);
    }

    const json = (await response.json()) as Record<string, unknown>;
    const data = (json.data ?? json) as Record<string, unknown>;

    const uid = typeof data.uid === 'string' ? data.uid : typeof data.id === 'string' ? data.id : '';
    if (!uid) {
        throw new Error('CALCOM_BOOKING_INVALID_RESPONSE');
    }

    const meetingUrl =
        typeof data.meetingUrl === 'string'
            ? data.meetingUrl
            : typeof data.location === 'string'
              ? data.location
              : null;

    return { uid, meetingUrl };
}

function parseCalComBookingResult(entry: Record<string, unknown>): CalComBookingResult | null {
    const uid =
        typeof entry.uid === 'string'
            ? entry.uid
            : typeof entry.id === 'string'
              ? entry.id
              : typeof entry.id === 'number'
                ? String(entry.id)
                : '';
    if (!uid) return null;

    const meetingUrl =
        typeof entry.meetingUrl === 'string'
            ? entry.meetingUrl
            : typeof entry.location === 'string' && entry.location.startsWith('http')
              ? entry.location
              : null;

    return { uid, meetingUrl };
}

function bookingMatchesSlot(
    entry: Record<string, unknown>,
    slotStartsAt: string,
    mentorUsername: string
): boolean {
    const startRaw = entry.start ?? entry.startTime;
    if (typeof startRaw !== 'string') return false;

    const targetMs = new Date(slotStartsAt).getTime();
    const startMs = new Date(startRaw).getTime();
    if (!Number.isFinite(targetMs) || !Number.isFinite(startMs)) return false;
    if (Math.abs(startMs - targetMs) > 90_000) return false;

    const hosts = entry.hosts;
    if (!Array.isArray(hosts) || !hosts.length) return true;

    const wanted = mentorUsername.trim().toLowerCase();
    return hosts.some((host) => {
        if (!host || typeof host !== 'object') return false;
        const username = (host as { username?: string }).username;
        return username?.trim().toLowerCase() === wanted;
    });
}

async function fetchCalComBookingsList(
    mentor: BookableMentor,
    params: Record<string, string>
): Promise<Record<string, unknown>[]> {
    const base = getCalComApiBaseForHost(mentor.calHost);
    const url = new URL(`${base}/bookings`);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: calHeaders(CAL_BOOKINGS_LIST_API_VERSION),
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.warn('[calcom] list bookings error', response.status, body.slice(0, 300));
        return [];
    }

    const json = (await response.json()) as Record<string, unknown>;
    const data = json.data;
    if (!Array.isArray(data)) return [];
    return data.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
}

/** Find an existing Cal.com booking when create fails or before retrying. */
export async function findCalComBookingForAttendeeSlot(input: {
    mentor: BookableMentor;
    slotStartsAt: string;
    attendeeEmail: string;
}): Promise<CalComBookingResult | null> {
    const email = input.attendeeEmail.trim().toLowerCase();
    const slotStart = new Date(input.slotStartsAt);
    const afterStart = new Date(slotStart.getTime() - 2 * 60 * 60_000).toISOString();
    const beforeEnd = new Date(slotStart.getTime() + 4 * 60 * 60_000).toISOString();

    for (const status of ['upcoming', 'unconfirmed', 'past'] as const) {
        const rows = await fetchCalComBookingsList(input.mentor, {
            attendeeEmail: email,
            status,
            afterStart,
            beforeEnd,
            take: '50',
        });

        for (const row of rows) {
            if (!bookingMatchesSlot(row, input.slotStartsAt, input.mentor.calUsername)) continue;
            const parsed = parseCalComBookingResult(row);
            if (parsed) {
                console.log('[calcom] found existing booking for reconcile', parsed.uid, status);
                return parsed;
            }
        }
    }

    return null;
}

export async function createOrReconcileCalComBooking(input: {
    mentor: BookableMentor;
    durationMinutes: DurationMinutes;
    slotStartsAt: string;
    attendeeName: string;
    attendeeEmail: string;
    attendeeTimeZone: string;
    goal?: string;
}): Promise<CalComBookingResult> {
    const existing = await findCalComBookingForAttendeeSlot({
        mentor: input.mentor,
        slotStartsAt: input.slotStartsAt,
        attendeeEmail: input.attendeeEmail,
    });
    if (existing) {
        return existing;
    }

    try {
        return await createCalComBooking(input);
    } catch (err) {
        if (err instanceof CalComBookingError && err.isDuplicateOrConflict()) {
            const reconciled = await findCalComBookingForAttendeeSlot({
                mentor: input.mentor,
                slotStartsAt: input.slotStartsAt,
                attendeeEmail: input.attendeeEmail,
            });
            if (reconciled) {
                return reconciled;
            }
        }
        if (err instanceof CalComBookingError) {
            throw new Error('CALCOM_BOOKING_FAILED');
        }
        throw err;
    }
}

export async function isCalComSlotAvailable(
    mentor: BookableMentor,
    durationMinutes: DurationMinutes,
    slotStartsAt: string
): Promise<boolean> {
    const target = new Date(slotStartsAt).getTime();
    if (!Number.isFinite(target)) return false;

    const windowStart = new Date(target - 60_000);
    const windowEnd = new Date(target + durationMinutes * 60_000 + 60_000);

    const slots = await fetchCalComSlots(mentor, durationMinutes, windowStart, windowEnd);
    return slots.some((slot) => new Date(slot.startsAt).getTime() === target);
}
