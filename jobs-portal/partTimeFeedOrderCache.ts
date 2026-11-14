import { createHash } from 'crypto';
import { getJobsPortalRedis } from './redisClient';

/** Shared across Vercel instances — same idea as main Jobs feed order cache. */
export const PART_TIME_FEED_ORDER_TTL_SECONDS = 86_400; // 24h
/** Searches are one-off and numerous — expire them sooner so Redis does not fill up. */
export const PART_TIME_SEARCH_ORDER_TTL_SECONDS = 3_600; // 1h

export interface CachedPartTimeFeedOrder {
    v: 1;
    ids: string[];
    builtAt: string;
}

/**
 * `catalogVersion` is the shared jobs catalog version (bumped by
 * /api/internal/jobs-catalog-synced), so a sync makes every cached order miss
 * instead of serving pre-sync results until the TTL runs out.
 */
export function buildPartTimeFeedOrderCacheKey(
    shuffleSeed: string,
    filterFingerprint: string,
    catalogVersion: number,
): string {
    const filterHash = createHash('sha256')
        .update(filterFingerprint)
        .digest('hex')
        .slice(0, 16);
    return `part-time-feed:v3:${catalogVersion}:${shuffleSeed}:${filterHash}`;
}

export async function getCachedPartTimeFeedOrder(
    cacheKey: string,
): Promise<string[] | null> {
    const redis = getJobsPortalRedis();
    if (!redis) return null;

    try {
        const raw = await redis.get<CachedPartTimeFeedOrder | string>(cacheKey);
        if (!raw) return null;

        const parsed: CachedPartTimeFeedOrder =
            typeof raw === 'string'
                ? (JSON.parse(raw) as CachedPartTimeFeedOrder)
                : raw;

        if (parsed.v !== 1 || !Array.isArray(parsed.ids)) return null;
        return parsed.ids.map(String);
    } catch (err) {
        console.warn('[partTimeFeed] order cache read failed:', err);
        return null;
    }
}

export async function setCachedPartTimeFeedOrder(
    cacheKey: string,
    ids: string[],
    ttlSeconds: number = PART_TIME_FEED_ORDER_TTL_SECONDS,
): Promise<void> {
    const redis = getJobsPortalRedis();
    if (!redis) return;

    const payload: CachedPartTimeFeedOrder = {
        v: 1,
        ids,
        builtAt: new Date().toISOString(),
    };

    try {
        await redis.set(cacheKey, payload, { ex: ttlSeconds });
    } catch (err) {
        console.warn('[partTimeFeed] order cache write failed:', err);
    }
}
