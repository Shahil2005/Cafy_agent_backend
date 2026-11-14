import { createHash } from 'crypto';
import type { TwoPhaseBrowseParams } from './browseFeed';
import { captureServerWarning } from '../lib/observability/sentry';
import { getJobsPortalRedis } from './redisClient';

import type { JobsCatalogCountry } from './jobsCatalog';
import { jobsCatalogCacheSegment, requiresFreshUkFeed } from './jobsCatalog';

export const JOBS_CATALOG_VERSION_KEY = 'jobs:catalog-version';
export const FEED_ORDER_CACHE_TTL_SECONDS = 86_400; // 24h
const GLOBAL_JOB_COUNT_TTL_SECONDS = 900; // 15 minutes

function globalJobCountKey(country: JobsCatalogCountry = 'uk'): string {
    return `jobs:global-total-count:${jobsCatalogCacheSegment(country)}`;
}

export interface CachedFeedOrder {
    v: 11;
    preferredIds: string[];
    secondaryIds: string[];
    levelOnlyIds: string[];
    remainderIds: string[];
    catalogVersion: number;
    builtAt: string;
}

export type BrowseFilterOpts = Pick<
    TwoPhaseBrowseParams,
    'excludedJobIds' | 'excludedCompanyIds' | 'companyId'
>;

export function buildBrowseFilterHash(opts: BrowseFilterOpts): string {
    const excludedJobs = (opts.excludedJobIds ?? []).slice().sort().join(',');
    const excludedCompanies = (opts.excludedCompanyIds ?? [])
        .slice()
        .sort((a, b) => a - b)
        .join(',');
    const payload = [opts.companyId ?? '', excludedJobs, excludedCompanies].join('|');
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function buildFeedOrderCacheKey(
    shuffleSeed: string,
    filterHash: string,
    catalogCountry: JobsCatalogCountry = 'uk'
): string {
    return `jobs-feed:v11:${jobsCatalogCacheSegment(catalogCountry)}:${shuffleSeed}:${filterHash}`;
}

export async function getJobsCatalogVersion(): Promise<number> {
    const redis = getJobsPortalRedis();
    if (!redis) return 1;

    try {
        const value = await redis.get<number>(JOBS_CATALOG_VERSION_KEY);
        return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : 1;
    } catch (err) {
        console.warn('[jobs-feed] Failed to read catalog version:', err);
        return 1;
    }
}

/** Call after job import/sync so cached feed orders rebuild on next browse. */
export async function bumpJobsCatalogVersion(): Promise<number> {
    const redis = getJobsPortalRedis();
    if (!redis) return 1;

    try {
        return await redis.incr(JOBS_CATALOG_VERSION_KEY);
    } catch (err) {
        console.warn('[jobs-feed] Failed to bump catalog version:', err);
        return 1;
    }
}

/**
 * Invalidate browse/search caches after a jobs catalog refresh (e.g. nightly sync).
 * Bumps catalog version so feed + search keys miss; clears the global job count.
 */
export async function invalidateJobsCatalogCaches(): Promise<{
    catalogVersion: number;
    redisAvailable: boolean;
    globalCountCleared: boolean;
}> {
    const redis = getJobsPortalRedis();
    const redisAvailable = Boolean(redis);
    const catalogVersion = await bumpJobsCatalogVersion();
    let globalCountCleared = false;

    if (redis) {
        try {
            await redis.del(
                globalJobCountKey('uk'),
                globalJobCountKey('ireland'),
                'jobs:company-job-counts:v1:uk',
                'jobs:company-job-counts:v1:ireland',
                'jobs:free-company-ids:v1:uk',
                'jobs:free-company-ids:v1:ireland'
            );
            globalCountCleared = true;
        } catch (err) {
            console.warn('[jobs-feed] Failed to clear global job count cache:', err);
        }
    } else if (process.env.NODE_ENV === 'production') {
        console.error(
            '[jobs-feed] Redis unavailable during catalog invalidation — browse/search caches may stay stale until TTL'
        );
        captureServerWarning('Jobs catalog invalidation without Redis', {
            tags: { area: 'jobs-portal', route: 'jobs-catalog-synced' },
        });
    }

    return { catalogVersion, redisAvailable, globalCountCleared };
}

export async function getCachedFeedOrder(
    cacheKey: string
): Promise<CachedFeedOrder | null> {
    const redis = getJobsPortalRedis();
    if (!redis) return null;

    try {
        const raw = await redis.get<CachedFeedOrder | string>(cacheKey);
        if (!raw) return null;

        const parsed: CachedFeedOrder =
            typeof raw === 'string' ? (JSON.parse(raw) as CachedFeedOrder) : raw;

        if (parsed.v !== 11 || !Array.isArray(parsed.preferredIds) || !Array.isArray(parsed.remainderIds)) {
            return null;
        }
        if (!Array.isArray(parsed.secondaryIds)) {
            parsed.secondaryIds = [];
        }
        if (!Array.isArray(parsed.levelOnlyIds)) {
            parsed.levelOnlyIds = [];
        }

        const currentVersion = await getJobsCatalogVersion();
        if (parsed.catalogVersion < currentVersion) {
            return null;
        }

        return parsed;
    } catch (err) {
        console.warn('[jobs-feed] Cache read failed:', err);
        return null;
    }
}

export async function setCachedFeedOrder(
    cacheKey: string,
    order: Omit<CachedFeedOrder, 'v' | 'builtAt'> & { builtAt?: string }
): Promise<void> {
    const redis = getJobsPortalRedis();
    if (!redis) return;

    const payload: CachedFeedOrder = {
        v: 11,
        preferredIds: order.preferredIds,
        secondaryIds: order.secondaryIds ?? [],
        levelOnlyIds: order.levelOnlyIds ?? [],
        remainderIds: order.remainderIds,
        catalogVersion: order.catalogVersion,
        builtAt: order.builtAt ?? new Date().toISOString(),
    };

    try {
        await redis.set(cacheKey, payload, { ex: FEED_ORDER_CACHE_TTL_SECONDS });
    } catch (err) {
        console.warn('[jobs-feed] Cache write failed:', err);
    }
}

export function isFeedOrderCacheEnabled(): boolean {
    return getJobsPortalRedis() !== null;
}

/** Cached catalog size for header display — avoids a count query on every feed request. */
export async function getCachedGlobalJobCount(
    fetchCount: () => Promise<number>,
    catalogCountry: JobsCatalogCountry = 'uk'
): Promise<number> {
    if (requiresFreshUkFeed(catalogCountry)) return fetchCount();
    const redis = getJobsPortalRedis();
    const cacheKey = globalJobCountKey(catalogCountry);
    if (redis) {
        try {
            const cached = await redis.get<number>(cacheKey);
            if (typeof cached === 'number' && Number.isFinite(cached) && cached >= 0) {
                return cached;
            }
        } catch (err) {
            console.warn('[jobs-feed] Global count cache read failed:', err);
        }
    }

    const count = await fetchCount();

    if (redis && count >= 0) {
        try {
            await redis.set(cacheKey, count, { ex: GLOBAL_JOB_COUNT_TTL_SECONDS });
        } catch (err) {
            console.warn('[jobs-feed] Global count cache write failed:', err);
        }
    }

    return count;
}
