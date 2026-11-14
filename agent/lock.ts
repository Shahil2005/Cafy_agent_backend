import { createHash, randomBytes } from 'node:crypto';
import { getJobsPortalRedis } from '../jobs-portal/redisClient';

/** Longer than the 60 s function cap, so a crashed turn can never hold the lock for long. */
const LOCK_SECONDS = 65;

/** Deletes the key only if it still holds this turn's token, so a late turn never frees another's lock. */
const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface LockStore {
    set(key: string, value: string, options: { nx: true; ex: number }): Promise<unknown>;
    eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export function lockKey(uid: string): string {
    return `agent:v1:busy:${createHash('sha256').update(uid).digest('hex').slice(0, 24)}`;
}

export interface TurnLock {
    acquired: boolean;
    release(): Promise<void>;
}

/**
 * One answer at a time per user: stops parallel tabs or scripts from multiplying cost and load.
 * Fails open when Redis is unavailable; the per-minute aiLimiter still bounds abuse.
 */
export async function acquireTurnLock(uid: string, store: LockStore | null = getJobsPortalRedis() as LockStore | null): Promise<TurnLock> {
    const free: TurnLock = { acquired: true, release: async () => undefined };
    if (!store) return free;
    const key = lockKey(uid);
    const token = randomBytes(12).toString('hex');
    try {
        const ok = await store.set(key, token, { nx: true, ex: LOCK_SECONDS });
        if (ok !== 'OK') return { acquired: false, release: async () => undefined };
    } catch (error) {
        console.warn('[agent] turn lock store unavailable:', (error as Error)?.message);
        return free;
    }
    let released = false;
    return {
        acquired: true,
        // Safe to call more than once: the handler frees the lock early and again in `finally`.
        async release() {
            if (released) return;
            released = true;
            await store.eval(RELEASE_SCRIPT, [key], [token]).catch(() => undefined);
        },
    };
}
