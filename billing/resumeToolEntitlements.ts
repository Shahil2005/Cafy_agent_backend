import * as admin from 'firebase-admin';
import {
    refreshSubscriptionIfExpired,
    isFullPremiumActive,
    type UserSubscription,
} from './subscriptionService';
import {
    getResumeToolLimits,
    type ResumeToolTier,
    type ResumeToolLimits,
} from './resumeToolConfig';

export type ResumeToolBucket = 'free' | 'paid';

export interface ResumeToolUsageBucket {
    aiRuns: number;
    imports: number;
    pdfDownloads: number;
    periodStart: string | null;
    periodEnd: string | null;
}

export interface ResumeToolMeterStatus {
    used: number;
    limit: number | null;
    remaining: number | null;
}

export interface ResumeToolStatusSlice {
    tier: ResumeToolTier;
    bucket: ResumeToolBucket;
    periodEnd: string | null;
    ai: ResumeToolMeterStatus;
    import: ResumeToolMeterStatus;
    pdfDownload: ResumeToolMeterStatus;
}

const EMPTY_BUCKET: ResumeToolUsageBucket = {
    aiRuns: 0,
    imports: 0,
    pdfDownloads: 0,
    periodStart: null,
    periodEnd: null,
};

export function resolveResumeToolTier(subscription: UserSubscription): ResumeToolTier {
    if (!isFullPremiumActive(subscription)) {
        return 'free';
    }
    if (subscription.billingInterval === 'quarterly') {
        return 'premium_quarterly';
    }
    return 'premium_monthly';
}

export function resolveResumeToolBucket(tier: ResumeToolTier): ResumeToolBucket {
    return tier === 'free' ? 'free' : 'paid';
}

function readUsageBucket(raw: unknown): ResumeToolUsageBucket {
    if (!raw || typeof raw !== 'object') {
        return { ...EMPTY_BUCKET };
    }
    const o = raw as Record<string, unknown>;
    return {
        aiRuns: typeof o.aiRuns === 'number' && o.aiRuns >= 0 ? o.aiRuns : 0,
        imports: typeof o.imports === 'number' && o.imports >= 0 ? o.imports : 0,
        pdfDownloads: typeof o.pdfDownloads === 'number' && o.pdfDownloads >= 0 ? o.pdfDownloads : 0,
        periodStart: typeof o.periodStart === 'string' ? o.periodStart : null,
        periodEnd: typeof o.periodEnd === 'string' ? o.periodEnd : null,
    };
}

export function getResumeToolUsageFromData(data: Record<string, unknown>): {
    free: ResumeToolUsageBucket;
    paid: ResumeToolUsageBucket;
} {
    const rt = data.usage && typeof data.usage === 'object' ? (data.usage as Record<string, unknown>).resumeTool : null;
    const rtObj = rt && typeof rt === 'object' ? (rt as Record<string, unknown>) : {};
    return {
        free: readUsageBucket(rtObj.free),
        paid: readUsageBucket(rtObj.paid),
    };
}

function meterStatus(used: number, limit: number | null): ResumeToolMeterStatus {
    if (limit === null) {
        return { used, limit: null, remaining: null };
    }
    return {
        used,
        limit,
        remaining: Math.max(0, limit - used),
    };
}

export function buildResumeToolStatus(
    tier: ResumeToolTier,
    buckets: { free: ResumeToolUsageBucket; paid: ResumeToolUsageBucket }
): ResumeToolStatusSlice {
    const bucketName = resolveResumeToolBucket(tier);
    const usage = bucketName === 'paid' ? buckets.paid : buckets.free;
    const limits = getResumeToolLimits(tier);

    return {
        tier,
        bucket: bucketName,
        periodEnd: bucketName === 'paid' ? usage.periodEnd : null,
        ai: meterStatus(usage.aiRuns, limits.ai),
        import: meterStatus(usage.imports, limits.import),
        pdfDownload: meterStatus(usage.pdfDownloads, limits.pdfDownload),
    };
}

export function subscriptionPeriodEndIso(subscription: UserSubscription): string | null {
    if (!subscription.currentPeriodEnd) {
        return null;
    }
    return subscription.currentPeriodEnd.toDate().toISOString();
}

export function paidPeriodNeedsReset(
    paid: ResumeToolUsageBucket,
    subscription: UserSubscription
): boolean {
    const subEnd = subscriptionPeriodEndIso(subscription);
    if (!subEnd) {
        return !paid.periodEnd;
    }
    return paid.periodEnd !== subEnd;
}

export async function loadResumeToolContext(
    uid: string,
    preloaded?: {
        subscription?: UserSubscription | null;
        data?: FirebaseFirestore.DocumentData | null;
    }
): Promise<{
    subscription: UserSubscription;
    tier: ResumeToolTier;
    buckets: { free: ResumeToolUsageBucket; paid: ResumeToolUsageBucket };
}> {
    const subscription =
        preloaded?.subscription != null
            ? await refreshSubscriptionIfExpired(uid, preloaded.subscription)
            : await refreshSubscriptionIfExpired(uid);
    let data = preloaded?.data ?? null;
    if (!data) {
        const snap = await admin.firestore().doc(`users/${uid}`).get();
        data = snap.data() || {};
    }
    const tier = resolveResumeToolTier(subscription);
    const buckets = getResumeToolUsageFromData(data);
    return { subscription, tier, buckets };
}

export async function getResumeToolStatusForUid(
    uid: string,
    preloaded?: {
        subscription?: UserSubscription | null;
        data?: FirebaseFirestore.DocumentData | null;
    }
): Promise<ResumeToolStatusSlice> {
    const { tier, buckets } = await loadResumeToolContext(uid, preloaded);
    return buildResumeToolStatus(tier, buckets);
}

export function isUnlimitedTier(tier: ResumeToolTier): boolean {
    const limits = getResumeToolLimits(tier);
    return limits.ai === null && limits.import === null && limits.pdfDownload === null;
}
