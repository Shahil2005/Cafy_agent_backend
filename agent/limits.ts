import { createHash } from 'node:crypto';
import { getJobsPortalRedis } from '../jobs-portal/redisClient';

export type AgentLimitKind = 'turns' | 'aiCalls';

const DEFAULT_LIMITS: Record<AgentLimitKind, number> = { turns: 150, aiCalls: 400 };
const KEY_TTL_SECONDS = 36 * 60 * 60;

export function dailyLimit(kind: AgentLimitKind): number {
    const env = kind === 'turns' ? process.env.AGENT_DAILY_TURNS : process.env.AGENT_DAILY_AI_CALLS;
    const value = parseInt(env || '', 10);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_LIMITS[kind];
}

/** Hashed uid keeps raw Firebase ids out of Redis key names. Only new `agent:v1:` keys are written. */
export function dailyKey(uid: string, kind: AgentLimitKind, now = new Date()): string {
    const day = now.toISOString().slice(0, 10).replace(/-/g, '');
    const user = createHash('sha256').update(uid).digest('hex').slice(0, 24);
    return `agent:v1:cap:${user}:${day}:${kind}`;
}

export interface CounterStore {
    incrby(key: string, amount: number): Promise<number>;
    expire(key: string, seconds: number): Promise<unknown>;
}

/**
 * Adds `amount` to today's counter and reports whether the user is still within the cap.
 * Fails open when Redis is unavailable: the per-minute aiLimiter still bounds abuse.
 */
export async function consumeDaily(
    uid: string,
    kind: AgentLimitKind,
    amount = 1,
    store: CounterStore | null = getJobsPortalRedis(),
): Promise<{ allowed: boolean; used: number; limit: number }> {
    const limit = dailyLimit(kind);
    if (!store) return { allowed: true, used: 0, limit };
    try {
        const key = dailyKey(uid, kind);
        const used = await store.incrby(key, amount);
        if (used === amount) await store.expire(key, KEY_TTL_SECONDS);
        return { allowed: used <= limit, used, limit };
    } catch (error) {
        console.warn('[agent] daily limit store unavailable:', (error as Error)?.message);
        return { allowed: true, used: 0, limit };
    }
}
