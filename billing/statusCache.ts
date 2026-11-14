/** Avoid importing other billing modules here (prevents circular deps). */
export type CachedBillingStatusPayload = Record<string, unknown> & {
    planSelection: {
        completed: boolean;
        chosenPlan?: string | null;
        completedAt?: string | null;
    };
};

const TTL_MS = Math.max(0, Number(process.env.BILLING_STATUS_CACHE_MS ?? 45_000));

const cache = new Map<string, { at: number; payload: CachedBillingStatusPayload }>();

/** Short in-memory TTL for /api/billing/status (per process). Set BILLING_STATUS_CACHE_MS=0 to disable. */
export function getCachedBillingStatusPayload(uid: string): CachedBillingStatusPayload | null {
    if (TTL_MS <= 0) return null;
    const entry = cache.get(uid);
    if (!entry) return null;
    if (Date.now() - entry.at > TTL_MS) {
        cache.delete(uid);
        return null;
    }
    return entry.payload;
}

export function setCachedBillingStatusPayload(
    uid: string,
    payload: CachedBillingStatusPayload
): void {
    if (TTL_MS <= 0) return;
    cache.set(uid, { at: Date.now(), payload });
}

export function invalidateBillingStatusCache(uid: string): void {
    cache.delete(uid);
}
