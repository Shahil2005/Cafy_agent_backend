import * as admin from 'firebase-admin';
import { getFreeExtensionAnalysisLimit } from './billing/config';
import {
    isFullPremiumActive,
    refreshSubscriptionIfExpired,
    type UserSubscription,
} from './billing/subscriptionService';
import { invalidateBillingStatusCache } from './billing/statusCache';

function userDocRef(userId: string) {
    return admin.firestore().doc(`users/${userId}`);
}

function readLifetimeCount(data: Record<string, unknown> | undefined): number {
    const extensionUsage = data?.extensionUsage;
    if (!extensionUsage || typeof extensionUsage !== 'object') {
        return 0;
    }
    const count = (extensionUsage as Record<string, unknown>).lifetimeCount;
    return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0;
}

/**
 * Get extension job analysis usage.
 * Free users: lifetime cap (FREE_LIFETIME_ANALYSIS_LIMIT).
 * Full Premium: unlimited, but `used` still reflects total analyses run.
 *
 * Pass `preloaded` to skip a duplicate users/{uid} read within the same request.
 */
export async function getUserUsageStatus(
    userId: string,
    preloaded?: {
        data?: FirebaseFirestore.DocumentData | null;
        subscription?: UserSubscription | null;
    }
): Promise<{
    allowed: boolean;
    used: number;
    limit: number | null;
    remaining: number | null;
    isPremium: boolean;
}> {
    let data = preloaded?.data ?? null;
    if (!data) {
        const snap = await userDocRef(userId).get();
        data = snap.data() || {};
    }
    const subscription =
        preloaded?.subscription ??
        ({ ...(data.subscription as UserSubscription | undefined) } as UserSubscription);
    const premiumActive = isFullPremiumActive(subscription);
    const used = readLifetimeCount(data);
    const limit = getFreeExtensionAnalysisLimit();

    if (premiumActive) {
        return { allowed: true, used, limit: null, remaining: null, isPremium: true };
    }

    const remaining = Math.max(0, limit - used);
    return {
        allowed: used < limit,
        used,
        limit,
        remaining,
        isPremium: false,
    };
}

/**
 * Reserve one extension job analysis slot and increment the lifetime counter.
 * Free users are blocked at the lifetime cap. Full Premium users are always allowed
 * but the count still increases for reporting.
 */
export async function checkAndIncrementUsage(
    userId: string,
    _timezone?: string
): Promise<{
    allowed: boolean;
    success?: boolean;
    used?: number;
    limit?: number | null;
    remaining?: number | null;
    isPremium?: boolean;
    error?: string;
}> {
    const limit = getFreeExtensionAnalysisLimit();
    const subscription = await refreshSubscriptionIfExpired(userId);
    const premiumActive = isFullPremiumActive(subscription);
    const db = admin.firestore();
    const ref = userDocRef(userId);

    try {
        const result = await db.runTransaction(async (transaction) => {
            const snap = await transaction.get(ref);
            const data = snap.data() || {};
            const used = readLifetimeCount(data);

            if (!premiumActive && used >= limit) {
                return {
                    allowed: false,
                    error: 'LIMIT_REACHED',
                    used,
                    limit,
                    remaining: 0,
                    isPremium: false,
                };
            }

            const next = used + 1;
            const extensionUsage: Record<string, unknown> = {
                lifetimeCount: next,
                lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
            };

            transaction.set(ref, { extensionUsage }, { merge: true });

            if (premiumActive) {
                transaction.set(
                    ref,
                    {
                        usage: {
                            aiCallCounts: {
                                extension_job_analysis: admin.firestore.FieldValue.increment(1),
                            },
                            aiCallCountsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        },
                    },
                    { merge: true }
                );
            }

            return {
                allowed: true,
                success: true,
                used: next,
                limit: premiumActive ? null : limit,
                remaining: premiumActive ? null : Math.max(0, limit - next),
                isPremium: premiumActive,
            };
        });
        if (result.allowed && result.success) {
            invalidateBillingStatusCache(userId);
        }
        return result;
    } catch (error) {
        console.error('Transaction failed in checkAndIncrementUsage:', error);
        throw new Error('Failed to update usage count');
    }
}
