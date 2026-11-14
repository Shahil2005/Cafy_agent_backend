import { createHash } from 'node:crypto';
import { getJobsPortalRedis } from '../jobs-portal/redisClient';

/**
 * A small cache shared by every server instance (Upstash Redis, `agent:v1:*` keys with an expiry),
 * with an in-memory fallback when Redis is not configured. It only ever speeds things up: a miss,
 * a Redis error or a slow reply is the same as no cache, never a failed answer.
 *
 * Only data without personal details goes here: job ids and scores, and vectors of short search texts,
 * all under hashed keys. CV text and CV quotes never do.
 */

export interface CacheStore {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown, options: { ex: number }): Promise<unknown>;
}

/** Redis answers in tens of milliseconds from the server, but can take ~0.8s from far away; slower counts as a miss. */
const REDIS_WAIT_MS = 1_500;
const MEMORY_MAX = 500;
const memory = new Map<string, { until: number; value: unknown }>();

const memoryStore: CacheStore = {
    async get(key) {
        const hit = memory.get(key);
        if (!hit) return null;
        if (hit.until < Date.now()) {
            memory.delete(key);
            return null;
        }
        return hit.value;
    },
    async set(key, value, { ex }) {
        if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value!);
        memory.set(key, { until: Date.now() + ex * 1000, value });
        return 'OK';
    },
};

function store(): CacheStore {
    return (getJobsPortalRedis() as CacheStore | null) ?? memoryStore;
}

/** Never waits long for the cache: a slow lookup counts as a miss. */
function quickly<T>(work: Promise<T>): Promise<T | null> {
    return Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), REDIS_WAIT_MS))]).catch(() => null);
}

export function cacheKey(kind: string, input: unknown): string {
    return `agent:v1:${kind}:${createHash('sha256').update(typeof input === 'string' ? input : JSON.stringify(input)).digest('hex').slice(0, 40)}`;
}

/** The work's result, or an error after `ms`: a call that never answers must not hold anything up for ever. */
export function withinMs<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms); });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The cached value for a key, or null. Never runs any work; a slow or broken cache is a miss. */
export async function peekCached<T>(key: string, valid: (value: unknown) => value is T, options: { store?: CacheStore } = {}): Promise<T | null> {
    const hit = await quickly((options.store ?? store()).get(key));
    return valid(hit) ? hit : null;
}

/** Saves a value without waiting for the cache. */
export function saveCached(key: string, ttlSeconds: number, value: unknown, options: { store?: CacheStore } = {}): void {
    void quickly((options.store ?? store()).set(key, value, { ex: ttlSeconds }));
}

/** Work already running on this server, by key: the same slow job asked for twice runs once. */
const running = new Map<string, Promise<unknown>>();

/**
 * The cached value, or the work's result (saved for next time). Work errors are thrown as usual and never cached.
 * A second request for the same key while the work runs waits for that work instead of starting it again,
 * so "try again" during a slow job search does not start a second full scan of the database.
 */
export async function cached<T>(key: string, ttlSeconds: number, work: () => Promise<T>, options: { store?: CacheStore; valid?: (value: unknown) => value is T } = {}): Promise<T> {
    const cache = options.store ?? store();
    const hit = await quickly(cache.get(key));
    if (hit !== null && hit !== undefined && (!options.valid || options.valid(hit))) return hit as T;
    const already = running.get(key);
    if (already) return already as Promise<T>;
    const job = work().then((value) => {
        void quickly(cache.set(key, value, { ex: ttlSeconds }));
        return value;
    });
    running.set(key, job);
    try {
        return await job;
    } finally {
        running.delete(key);
    }
}
