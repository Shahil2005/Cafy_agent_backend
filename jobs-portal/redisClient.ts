import { Redis } from '@upstash/redis';

let _redis: Redis | null | undefined;

/** Shared Upstash client for jobs-portal caches (same env as rate limiting). */
export function getJobsPortalRedis(): Redis | null {
    if (_redis !== undefined) {
        return _redis;
    }

    const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
    const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

    if (!url || !token) {
        _redis = null;
        return null;
    }

    _redis = new Redis({ url, token });
    return _redis;
}
