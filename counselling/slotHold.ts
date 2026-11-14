import { getJobsPortalRedis } from '../jobs-portal/redisClient';
import { getSlotHoldMinutes } from './config';

function normalizeSlotKey(slotStartsAt: string): string {
    return new Date(slotStartsAt).toISOString();
}

function holdKey(mentorId: number, slotStartsAt: string): string {
    return `counselling:hold:${mentorId}:${normalizeSlotKey(slotStartsAt)}`;
}

/** Production counselling requires Redis for slot holds (fail closed). */
export function isSlotHoldRedisRequired(): boolean {
    if (process.env.COUNSELLING_REQUIRE_REDIS === 'false') {
        return false;
    }
    return process.env.NODE_ENV === 'production' || process.env.COUNSELLING_REQUIRE_REDIS === 'true';
}

function redisUnavailableError(): Error {
    const err = new Error('BOOKING_LOCK_UNAVAILABLE');
    return err;
}

export async function acquireSlotHold(
    mentorId: number,
    slotStartsAt: string,
    userId: string,
    ttlSeconds?: number
): Promise<boolean> {
    const redis = getJobsPortalRedis();
    if (!redis) {
        if (isSlotHoldRedisRequired()) {
            throw redisUnavailableError();
        }
        return true;
    }

    const key = holdKey(mentorId, slotStartsAt);
    const ttl = ttlSeconds ?? getSlotHoldMinutes() * 60;

    try {
        const result = await redis.set(key, userId, { nx: true, ex: ttl });
        if (result === 'OK') {
            return true;
        }

        const holder = await redis.get<string>(key);
        return holder === userId;
    } catch (err) {
        console.error('[counselling] slot hold acquire failed', err);
        if (isSlotHoldRedisRequired()) {
            throw redisUnavailableError();
        }
        return true;
    }
}

export async function extendSlotHold(
    mentorId: number,
    slotStartsAt: string,
    userId: string,
    ttlSeconds?: number
): Promise<boolean> {
    const redis = getJobsPortalRedis();
    if (!redis) {
        if (isSlotHoldRedisRequired()) {
            throw redisUnavailableError();
        }
        return true;
    }

    const key = holdKey(mentorId, slotStartsAt);
    const ttl = ttlSeconds ?? getSlotHoldMinutes() * 60;

    try {
        const holder = await redis.get<string>(key);
        if (holder && holder !== userId) {
            return false;
        }
        await redis.set(key, userId, { ex: ttl });
        return true;
    } catch (err) {
        console.error('[counselling] slot hold extend failed', err);
        if (isSlotHoldRedisRequired()) {
            throw redisUnavailableError();
        }
        return true;
    }
}

export async function releaseSlotHold(mentorId: number, slotStartsAt: string, userId?: string): Promise<void> {
    const redis = getJobsPortalRedis();
    if (!redis) return;

    const key = holdKey(mentorId, slotStartsAt);

    try {
        if (userId) {
            const holder = await redis.get<string>(key);
            if (holder && holder !== userId) {
                return;
            }
        }
        await redis.del(key);
    } catch (err) {
        console.error('[counselling] slot hold release failed', err);
    }
}

const REDIS_MGET_CHUNK = 100;

export async function filterHeldSlots<T extends { startsAt: string }>(
    mentorId: number,
    slots: T[],
    currentUserId: string
): Promise<T[]> {
    const redis = getJobsPortalRedis();
    if (!redis) {
        if (isSlotHoldRedisRequired()) {
            throw redisUnavailableError();
        }
        return slots;
    }

    if (slots.length === 0) {
        return slots;
    }

    try {
        const kept: T[] = [];

        for (let i = 0; i < slots.length; i += REDIS_MGET_CHUNK) {
            const chunk = slots.slice(i, i + REDIS_MGET_CHUNK);
            const keys = chunk.map((slot) => holdKey(mentorId, slot.startsAt));
            const holders = await redis.mget<(string | null)[]>(...keys);

            for (let j = 0; j < chunk.length; j++) {
                const holder = holders[j];
                if (!holder || holder === currentUserId) {
                    kept.push(chunk[j]);
                }
            }
        }

        return kept;
    } catch (err) {
        console.error('[counselling] filter held slots failed', err);
        if (isSlotHoldRedisRequired()) {
            throw redisUnavailableError();
        }
        return slots;
    }
}
