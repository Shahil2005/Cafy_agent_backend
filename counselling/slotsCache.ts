import type { CounsellingSlot, DurationMinutes } from './types';

const TTL_MS = 45_000;
const cache = new Map<string, { expires: number; slots: CounsellingSlot[] }>();

export function slotsCacheKey(
    mentorId: number,
    durationMinutes: DurationMinutes,
    startTime: Date,
    endTime: Date
): string {
    const start = startTime.toISOString().slice(0, 10);
    const end = endTime.toISOString().slice(0, 10);
    return `${mentorId}:${durationMinutes}:${start}:${end}`;
}

export function readSlotsCache(key: string): CounsellingSlot[] | null {
    const entry = cache.get(key);
    if (!entry || entry.expires <= Date.now()) {
        if (entry) cache.delete(key);
        return null;
    }
    return entry.slots;
}

export function writeSlotsCache(key: string, slots: CounsellingSlot[]): void {
    cache.set(key, { expires: Date.now() + TTL_MS, slots });
}

function normalizeSlotIso(iso: string): string {
    return new Date(iso).toISOString();
}

/**
 * Returns whether a slot appeared in a recent Cal.com fetch for this mentor/duration.
 * `null` = cache miss (caller should re-check via Cal.com API).
 */
export function isSlotInAvailabilityCache(
    mentorId: number,
    durationMinutes: DurationMinutes,
    slotIso: string,
    startTime: Date,
    endTime: Date
): boolean | null {
    const key = slotsCacheKey(mentorId, durationMinutes, startTime, endTime);
    const cached = readSlotsCache(key);
    if (!cached) {
        return null;
    }
    const target = normalizeSlotIso(slotIso);
    return cached.some((slot) => normalizeSlotIso(slot.startsAt) === target);
}

/** Test helper — clear in-memory cache after env changes. */
export function clearSlotsCacheForTest(): void {
    cache.clear();
}
