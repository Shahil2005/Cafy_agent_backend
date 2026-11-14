import { getAutofillUsageStatus } from './autofillEntitlements';
import {
    getUserBillingDoc,
    refreshSubscriptionIfExpired,
    isFullPremiumActive,
    isJobsPremiumActive,
    isPartTimePremiumActive,
    repairSubscriptionPlanFromPriceId,
    type UserSubscription,
} from './subscriptionService';
import { getFreeCommLimit, getFreeExtCoverLetterLimit } from './config';
import { syncUserSubscriptionFromStripe } from './stripeSubscriptionSync';
import { isStripeConfigured } from './stripeClient';
import { subscriptionNeedsRepair } from './priceRegistry';
import { isResumeToolBillingEnabled } from './resumeToolConfig';
import { getResumeToolStatusForUid, type ResumeToolStatusSlice } from './resumeToolEntitlements';
import { getUserUsageStatus } from '../usageService';
import { getCareerAnalysisUsageStatus } from './careerAnalysisEntitlements';
import { getUserAiCallCounts } from './aiCallTracking';
import { AI_CALL_CATEGORY_LABELS, type AiCallCategory, type AiCallCounts } from './aiCallCategories';
import { resolvePriceDisplayByPriceId } from './planPricing';

export type ProductTier = 'free' | 'part_time' | 'jobs_only' | 'full';

export interface BillingStatusResponse {
    plan: 'free' | 'part_time' | 'jobs_premium' | 'premium';
    status: string;
    /** Full Premium — unlimited AI, extension, resume (backward compat). */
    isPremium: boolean;
    isFullPremium: boolean;
    isJobsPremium: boolean;
    /** Full UK part-time jobs access (part-time weekly, Jobs Premium, or Full Premium). */
    isPartTimePremium: boolean;
    productTier: ProductTier;
    provider: string;
    billingInterval?: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    /** Active subscription's Stripe price (grandfathered or current). */
    subscriptionPriceDisplay?: string | null;
    subscriptionPricePeriod?: string | null;
    commUsed: number;
    commLimit: number;
    commRemaining: number | null;
    extCoverLetterUsed: number;
    extCoverLetterLimit: number;
    extCoverLetterRemaining: number | null;
    /** Extension autofill: runs used, the limit and what's left - free: for the account's lifetime;
     *  Full Premium: today (UK), replaced on autofillResetsOn */
    autofillUsed: number;
    autofillLimit: number;
    autofillRemaining: number;
    autofillPeriod: 'lifetime' | 'day';
    autofillResetsOn: string | null;
    /** Every autofill run on the account, any plan */
    autofillTotal: number;
    extAnalysisUsed: number;
    extAnalysisLimit: number | null;
    extAnalysisRemaining: number | null;
    /**
     * Career Path analysis usage — "lifetime" for free/Jobs Premium, "daily" for Full Premium,
     * "unlimited" for allowlisted emails (limit/remaining are null in that case).
     */
    careerAnalysisTier: 'lifetime' | 'daily' | 'unlimited';
    careerAnalysisUsed: number;
    careerAnalysisLimit: number | null;
    careerAnalysisRemaining: number | null;
    careerAnalysisResetAt: string | null;
    source: string;
    resumeTool?: ResumeToolStatusSlice;
    /** Paid-user AI usage totals by feature (lifetime on current account). */
    aiCallCounts?: AiCallCounts;
    aiCallCountLabels?: Record<AiCallCategory, string>;
}

function resolveProductTier(subscription: UserSubscription): ProductTier {
    if (isFullPremiumActive(subscription)) return 'full';
    if (isJobsPremiumActive(subscription)) return 'jobs_only';
    if (isPartTimePremiumActive(subscription) && subscription.plan === 'part_time') {
        return 'part_time';
    }
    return 'free';
}

function resolvePlanField(
    subscription: UserSubscription
): 'free' | 'part_time' | 'jobs_premium' | 'premium' {
    if (isFullPremiumActive(subscription)) return 'premium';
    if (isJobsPremiumActive(subscription)) return 'jobs_premium';
    if (isPartTimePremiumActive(subscription) && subscription.plan === 'part_time') {
        return 'part_time';
    }
    return subscription.plan === 'jobs_premium' ||
        subscription.plan === 'premium' ||
        subscription.plan === 'part_time'
        ? subscription.plan
        : 'free';
}

/**
 * Build billing status for a user.
 *
 * Reads users/{uid} once (or twice if Stripe sync/repair writes). All downstream
 * helpers reuse that document — no duplicate .get() fan-out per request.
 */
export async function buildBillingStatus(
    uid: string,
    options?: {
        syncStripe?: boolean;
        /** Preloaded users/{uid} snap or data from the same request (e.g. plan-selection). */
        preloaded?: FirebaseFirestore.DocumentSnapshot | FirebaseFirestore.DocumentData | null;
        /** Called when this function performs an extra users/{uid} read after a write. */
        onUserDocRead?: () => void;
        /** Verified Firebase token email — used only for the Career Path unlimited allowlist. */
        email?: string | null;
    }
): Promise<BillingStatusResponse> {
    let { subscription: current, usage, data } = await getUserBillingDoc(uid, options?.preloaded);

    if (isStripeConfigured()) {
        const needsRepair = subscriptionNeedsRepair({
            status: current.status,
            plan: current.plan,
            billingInterval: current.billingInterval ?? null,
            priceId: current.priceId ?? null,
            stripeSubscriptionId: current.stripeSubscriptionId ?? null,
        });
        if (options?.syncStripe || needsRepair) {
            try {
                await syncUserSubscriptionFromStripe(uid);
                // Sync may have written — one fresh read, then reuse below.
                ({ subscription: current, usage, data } = await getUserBillingDoc(uid));
                options?.onUserDocRead?.();
            } catch (err) {
                console.warn('[billing] Stripe sync on status failed:', err);
                if (needsRepair) {
                    try {
                        await repairSubscriptionPlanFromPriceId(uid);
                        ({ subscription: current, usage, data } = await getUserBillingDoc(uid));
                        options?.onUserDocRead?.();
                    } catch (repairErr) {
                        console.warn('[billing] Firestore plan repair failed:', repairErr);
                    }
                }
            }
        }
    }

    const subscription = await refreshSubscriptionIfExpired(uid, current);
    const limit = getFreeCommLimit();
    const extCoverLetterLimit = getFreeExtCoverLetterLimit();
    const fullPremium = isFullPremiumActive(subscription);
    const jobsPremium = isJobsPremiumActive(subscription);
    const partTimePremium = isPartTimePremiumActive(subscription);
    const used = usage.commGenerationsTotal;
    const extCoverLetterUsed = usage.extensionCoverLetterTotal;
    const extAnalysis = await getUserUsageStatus(uid, { data, subscription });
    const careerAnalysis = await getCareerAnalysisUsageStatus(uid, { data, subscription }, options?.email);
    const autofill = await getAutofillUsageStatus(uid, { data, subscription });

    const status: BillingStatusResponse = {
        plan: resolvePlanField(subscription),
        status: subscription.status,
        isPremium: fullPremium,
        isFullPremium: fullPremium,
        isJobsPremium: jobsPremium,
        isPartTimePremium: partTimePremium,
        productTier: resolveProductTier(subscription),
        provider: subscription.provider,
        billingInterval: subscription.billingInterval ?? null,
        currentPeriodStart: subscription.currentPeriodStart
            ? subscription.currentPeriodStart.toDate().toISOString()
            : null,
        currentPeriodEnd: subscription.currentPeriodEnd
            ? subscription.currentPeriodEnd.toDate().toISOString()
            : null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? false,
        commUsed: used,
        commLimit: limit,
        commRemaining: fullPremium ? null : Math.max(0, limit - used),
        extCoverLetterUsed,
        extCoverLetterLimit,
        extCoverLetterRemaining: fullPremium ? null : Math.max(0, extCoverLetterLimit - extCoverLetterUsed),
        autofillUsed: autofill.used,
        autofillLimit: autofill.limit,
        autofillRemaining: autofill.remaining,
        autofillPeriod: autofill.period,
        autofillResetsOn: autofill.resetsOn,
        autofillTotal: autofill.total,
        extAnalysisUsed: extAnalysis.used,
        extAnalysisLimit: extAnalysis.limit,
        extAnalysisRemaining: extAnalysis.remaining,
        careerAnalysisTier: careerAnalysis.tier,
        careerAnalysisUsed: careerAnalysis.used,
        careerAnalysisLimit: careerAnalysis.limit,
        careerAnalysisRemaining: careerAnalysis.remaining,
        careerAnalysisResetAt: careerAnalysis.resetAt,
        source: subscription.provider,
    };

    if (isResumeToolBillingEnabled()) {
        try {
            status.resumeTool = await getResumeToolStatusForUid(uid, {
                subscription,
                data,
            });
        } catch (err) {
            console.warn('[billing] resumeTool status failed:', err);
        }
    }

    if (fullPremium || jobsPremium) {
        try {
            status.aiCallCounts = await getUserAiCallCounts(uid, data);
            status.aiCallCountLabels = AI_CALL_CATEGORY_LABELS;
        } catch (err) {
            console.warn('[billing] aiCallCounts failed:', err);
        }
    }

    if ((fullPremium || jobsPremium || partTimePremium) && subscription.priceId) {
        try {
            const price = await resolvePriceDisplayByPriceId(subscription.priceId);
            if (price) {
                status.subscriptionPriceDisplay = price.priceDisplay;
                status.subscriptionPricePeriod = price.pricePeriod;
            }
        } catch (err) {
            console.warn('[billing] subscription price display failed:', err);
        }
    }

    return status;
}
