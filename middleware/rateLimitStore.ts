import { Redis } from '@upstash/redis';
import RedisIo from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';

export type RateLimitBackend = 'memory' | 'upstash-rest' | 'redis-url';

type SendCommandFn = (...args: string[]) => Promise<RedisReply>;

let backend: RateLimitBackend = 'memory';
let sendCommand: SendCommandFn | null = null;

function isRedisRequired(): boolean {
    return process.env.RATE_LIMIT_REDIS_REQUIRED === 'true';
}

function hasUpstashRestConfig(): boolean {
    return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function hasRedisUrlConfig(): boolean {
    return Boolean(process.env.REDIS_URL?.trim());
}

/**
 * Prefer Upstash REST on serverless (no persistent TCP). Fall back to REDIS_URL (ioredis).
 */
export function initRateLimitStore(): RateLimitBackend {
    if (sendCommand) {
        return backend;
    }

    if (hasUpstashRestConfig()) {
        const redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL!,
            token: process.env.UPSTASH_REDIS_REST_TOKEN!,
        });

        sendCommand = async (...args: string[]) => {
            return redis.exec(args as [string, ...string[]]) as Promise<RedisReply>;
        };
        backend = 'upstash-rest';
        console.log('[rate-limit] Using Upstash REST Redis store');
        return backend;
    }

    if (hasRedisUrlConfig()) {
        const client = new RedisIo(process.env.REDIS_URL!, {
            // null is required for rate-limit-redis Lua SCRIPT LOAD (blocking commands).
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            connectTimeout: 5_000,
            lazyConnect: false,
        });

        client.on('error', (err) => {
            console.error('[rate-limit] Redis connection error:', err.message);
        });

        sendCommand = async (...args: string[]) => {
            const [command, ...commandArgs] = args;
            return client.call(command, ...commandArgs) as Promise<RedisReply>;
        };
        backend = 'redis-url';
        console.log('[rate-limit] Using REDIS_URL (TCP) store');
        return backend;
    }

    if (isRedisRequired()) {
        console.error(
            '[rate-limit] RATE_LIMIT_REDIS_REQUIRED=true but no UPSTASH_REDIS_REST_* or REDIS_URL is set. ' +
                'Falling back to in-memory store (not safe on multi-instance deployments).'
        );
    } else if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
        console.warn(
            '[rate-limit] No Redis configured — using in-memory store. Set UPSTASH_REDIS_REST_URL + ' +
                'UPSTASH_REDIS_REST_TOKEN (recommended) or REDIS_URL for distributed limits.'
        );
    }

    backend = 'memory';
    return backend;
}

export function getRateLimitBackend(): RateLimitBackend {
    return backend;
}

function isDistributedRateLimitEnabled(): boolean {
    return backend !== 'memory';
}

export function shouldFailClosedOnStoreError(): boolean {
    return isRedisRequired() && isDistributedRateLimitEnabled();
}

export function createRedisStore(prefix: string): RedisStore | undefined {
    initRateLimitStore();
    if (!sendCommand) {
        return undefined;
    }
    return new RedisStore({
        sendCommand,
        prefix,
    });
}

export type RateLimitRedisHealth = 'ok' | 'error' | 'skipped';

/** Lightweight PING for /api/health — error when required but unavailable; skipped when optional. */
export async function checkRateLimitRedisHealth(): Promise<RateLimitRedisHealth> {
    initRateLimitStore();
    if (!sendCommand || backend === 'memory') {
        return isRedisRequired() ? 'error' : 'skipped';
    }

    try {
        const reply = await Promise.race([
            sendCommand('PING'),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Redis health check timeout')), 3_000)
            ),
        ]);
        const normalized = typeof reply === 'string' ? reply.toUpperCase() : String(reply);
        return normalized === 'PONG' || normalized === '1' ? 'ok' : 'error';
    } catch {
        return 'error';
    }
}

export function isRateLimitRedisRequired(): boolean {
    return isRedisRequired();
}
