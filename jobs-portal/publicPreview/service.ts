import { requiresFreshUkFeed } from '../jobsCatalog';
/**
 * Public preview service — cache-first with stale-while-revalidate.
 *
 * - Fresh for 15 min, served stale for up to 1 h if the DB is slow or down.
 * - Single-flight per key (in-process promise + Redis NX lock) so a traffic spike
 *   rebuilds each key once instead of stampeding Supabase.
 * - In-memory LRU fallback when Upstash is not configured or unreachable.
 */
import { getPublicPreviewFeed } from '../service';
import { getPartTimeJobsFeed } from '../partTimeFeed';
import { toPublicPortalJobs } from '../publicResponse';
import type { JobsPortalJob } from '../types';
import { getJobsPortalRedis } from '../redisClient';
import { getJobsCatalogVersion } from '../feedOrderCache';
import { publicPreviewCacheKey, type PublicPreviewQuery } from './schema';
import { remainingJobsLabel, toAnonPreviewJob, type PublicPreviewPayload } from './projection';

export const PUBLIC_PREVIEW_LIMIT = 15;

const FRESH_MS = 15 * 60 * 1000;
const STALE_TTL_SECONDS = 60 * 60;
const DB_TIMEOUT_MS = 8000;
/** All-UK part-time order is large on a cold cache; it is pre-warmed by the catalog-sync cron. */
const PART_TIME_DB_TIMEOUT_MS = 12000;
const LOCK_TTL_SECONDS = 15;
const MEMORY_CACHE_MAX_KEYS = 200;

interface CacheEntry {
    data: PublicPreviewPayload;
    at: number;
}

const memoryCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<PublicPreviewPayload>>();

function memoryGet(key: string): CacheEntry | null {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > STALE_TTL_SECONDS * 1000) {
        memoryCache.delete(key);
        return null;
    }
    // Refresh LRU position
    memoryCache.delete(key);
    memoryCache.set(key, entry);
    return entry;
}

function memorySet(key: string, entry: CacheEntry): void {
    memoryCache.delete(key);
    memoryCache.set(key, entry);
    while (memoryCache.size > MEMORY_CACHE_MAX_KEYS) {
        const oldest = memoryCache.keys().next().value;
        if (oldest === undefined) break;
        memoryCache.delete(oldest);
    }
}

async function redisGet(key: string): Promise<CacheEntry | null> {
    const redis = getJobsPortalRedis();
    if (!redis) return null;
    try {
        const entry = await redis.get<CacheEntry>(key);
        return entry && typeof entry.at === 'number' && entry.data ? entry : null;
    } catch (err) {
        console.warn('[public-preview] redis read failed:', err);
        return null;
    }
}

async function redisSet(key: string, entry: CacheEntry): Promise<void> {
    const redis = getJobsPortalRedis();
    if (!redis) return;
    try {
        await redis.set(key, entry, { ex: STALE_TTL_SECONDS });
    } catch (err) {
        console.warn('[public-preview] redis write failed:', err);
    }
}

/** Cross-instance rebuild lock. Returns true when this instance should rebuild. */
async function acquireRebuildLock(key: string): Promise<boolean> {
    const redis = getJobsPortalRedis();
    if (!redis) return true;
    try {
        const ok = await redis.set(`${key}:lock`, '1', { nx: true, ex: LOCK_TTL_SECONDS });
        return ok === 'OK';
    } catch {
        return true;
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Public preview query timed out')), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

async function buildPayload(query: PublicPreviewQuery): Promise<PublicPreviewPayload> {
    const feed = await withTimeout(
        getPublicPreviewFeed(
            {
                sectors: query.sectors,
                experienceLevels: query.levels,
                jobTypes: query.jobTypes,
                catalogCountry: query.country,
            },
            PUBLIC_PREVIEW_LIMIT
        ),
        DB_TIMEOUT_MS
    );
    return toPayload(feed.jobs, feed.totalCount, PUBLIC_PREVIEW_LIMIT);
}

/** Single cache key: the public part-time preview is all-UK only (location filter needs login). */
const PART_TIME_PREVIEW_KEY_PREFIX = 'public-preview-pt:v3';

async function partTimePreviewKey(): Promise<string> {
    const version = await getJobsCatalogVersion();
    return `${PART_TIME_PREVIEW_KEY_PREFIX}:${version}:all`;
}

async function buildPartTimePayload(
    timeoutMs: number | null = PART_TIME_DB_TIMEOUT_MS
): Promise<PublicPreviewPayload> {
    // No userId → fixed 'anon' shuffle seed: deterministic, Redis-cached order.
    const feedPromise = getPartTimeJobsFeed({
        page: 1,
        limit: PUBLIC_PREVIEW_LIMIT,
        maxJobsReturned: PUBLIC_PREVIEW_LIMIT,
    });
    const feed = timeoutMs === null ? await feedPromise : await withTimeout(feedPromise, timeoutMs);
    return toPayload(toPublicPortalJobs(feed.jobs as unknown[]), feed.totalCount, PUBLIC_PREVIEW_LIMIT);
}

function toPayload(rawJobs: JobsPortalJob[], totalCount: number, limit: number): PublicPreviewPayload {
    const jobs = rawJobs.slice(0, limit).map(toAnonPreviewJob);
    const moreLabel = remainingJobsLabel(totalCount, jobs.length);
    return {
        jobs,
        previewLimit: limit,
        hasMore: moreLabel !== null,
        moreLabel,
    };
}

async function rebuild(
    key: string,
    build: () => Promise<PublicPreviewPayload>
): Promise<PublicPreviewPayload> {
    const existing = inflight.get(key);
    if (existing) return existing;

    const task = (async () => {
        const data = await build();
        const entry = { data, at: Date.now() };
        memorySet(key, entry);
        await redisSet(key, entry);
        return data;
    })();

    inflight.set(key, task);
    try {
        return await task;
    } finally {
        inflight.delete(key);
    }
}

/** Shared cache-first read: fresh 15 min, stale up to 1 h with one background refresh. */
async function getCachedPreview(
    key: string,
    build: () => Promise<PublicPreviewPayload>
): Promise<PublicPreviewPayload> {
    const cached = memoryGet(key) ?? (await redisGet(key));
    if (cached) {
        memorySet(key, cached);
        if (Date.now() - cached.at < FRESH_MS) {
            return cached.data;
        }
        // Stale: serve immediately; one instance refreshes in the background.
        void acquireRebuildLock(key)
            .then((acquired) => (acquired ? rebuild(key, build) : undefined))
            .catch((err) => console.warn('[public-preview] background refresh failed:', err));
        return cached.data;
    }

    return rebuild(key, build);
}

export async function getPublicPreview(query: PublicPreviewQuery): Promise<PublicPreviewPayload> {
    if (requiresFreshUkFeed(query.country)) {
        // Share concurrent work only; never serve a completed stale publication snapshot.
        const key=`fresh:${publicPreviewCacheKey(query)}`;
        const running=inflight.get(key);
        if(running)return running;
        const promise=buildPayload(query).finally(()=>inflight.delete(key));
        inflight.set(key,promise);
        return promise;
    }
    const version = await getJobsCatalogVersion();
    const key = `public-preview:v5:${version}:${publicPreviewCacheKey(query)}`;
    return getCachedPreview(key, () => buildPayload(query));
}

export async function getPublicPartTimePreview(): Promise<PublicPreviewPayload> {
    return getCachedPreview(await partTimePreviewKey(), () => buildPartTimePayload());
}

/**
 * Cron warm-up (after catalog sync): builds the all-UK part-time order (~20k ids,
 * too slow for a visitor's first request) and caches the preview payload.
 */
export async function warmPublicPartTimePreview(): Promise<void> {
    await rebuild(await partTimePreviewKey(), () => buildPartTimePayload(null));
}
