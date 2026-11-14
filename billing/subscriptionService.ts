import * as admin from 'firebase-admin';
import { getFreeCommLimit, getFreeExtCoverLetterLimit } from './config';
import { resolvePriceMapping, subscriptionNeedsRepair } from './priceRegistry';
import { invalidateBillingStatusCache } from './statusCache';

export type SubscriptionPlan = 'free' | 'part_time' | 'jobs_premium' | 'premium';
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'expired' | 'none';
export type SubscriptionProvider = 'stripe' | 'none';
export type BillingInterval = 'weekly' | 'monthly' | 'quarterly' | 'unknown';

export interface UserSubscription {
    provider: SubscriptionProvider;
    plan: SubscriptionPlan;
    status: SubscriptionStatus;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    priceId?: string | null;
    billingInterval?: BillingInterval | null;
    /** Stripe Dashboard promotion code applied at Checkout (audit) */
    stripePromotionCode?: string | null;
    currentPeriodStart?: admin.firestore.Timestamp | null;
    currentPeriodEnd?: admin.firestore.Timestamp | null;
    cancelAtPeriodEnd?: boolean;
    /** Last paid plan before cancel/expiry — used for win-back eligibility. */
    lastPaidPlan?: SubscriptionPlan | null;
}

export interface UserUsage {
    commGenerationsTotal: number;
    extensionCoverLetterTotal: number;
}

const DEFAULT_SUBSCRIPTION: UserSubscription = {
    provider: 'none',
    plan: 'free',
    status: 'none',
};

function userRef(uid: string) {
    return admin.firestore().doc(`users/${uid}`);
}

/** Parse billing fields from an already-loaded users/{uid} document (no Firestore read). */
export function parseUserBillingDoc(data: FirebaseFirestore.DocumentData | undefined | null): {
    subscription: UserSubscription;
    usage: UserUsage;
} {
    const raw = data || {};
    const subscription = { ...DEFAULT_SUBSCRIPTION, ...(raw.subscription || {}) } as UserSubscription;
    const usage: UserUsage = {
        commGenerationsTotal: typeof raw.usage?.commGenerationsTotal === 'number'
            ? raw.usage.commGenerationsTotal
            : 0,
        extensionCoverLetterTotal: typeof raw.usage?.extensionCoverLetterTotal === 'number'
            ? raw.usage.extensionCoverLetterTotal
            : 0,
    };
    return { subscription, usage };
}

export type PreloadedUserDoc =
    | FirebaseFirestore.DocumentSnapshot
    | FirebaseFirestore.DocumentData
    | null
    | undefined;

function resolvePreloadedData(preloaded?: PreloadedUserDoc): FirebaseFirestore.DocumentData | null {
    if (!preloaded) return null;
    if (typeof (preloaded as FirebaseFirestore.DocumentSnapshot).data === 'function') {
        return (preloaded as FirebaseFirestore.DocumentSnapshot).data() || {};
    }
    return preloaded as FirebaseFirestore.DocumentData;
}

/**
 * Load users/{uid} billing fields.
 * Pass `preloaded` (snap or data) to skip an extra Firestore read within the same request.
 */
export async function getUserBillingDoc(
    uid: string,
    preloaded?: PreloadedUserDoc
): Promise<{
    subscription: UserSubscription;
    usage: UserUsage;
    data: FirebaseFirestore.DocumentData;
}> {
    const fromPreload = resolvePreloadedData(preloaded);
    if (fromPreload) {
        const parsed = parseUserBillingDoc(fromPreload);
        return { ...parsed, data: fromPreload };
    }
    const snap = await userRef(uid).get();
    const data = snap.data() || {};
    const parsed = parseUserBillingDoc(data);
    return { ...parsed, data };
}

function isPaidPlanActive(subscription: UserSubscription): boolean {
    if (subscription.status !== 'active') {
        return false;
    }
    if (
        subscription.plan !== 'premium' &&
        subscription.plan !== 'jobs_premium' &&
        subscription.plan !== 'part_time'
    ) {
        return false;
    }
    if (subscription.currentPeriodEnd) {
        return subscription.currentPeriodEnd.toMillis() > Date.now();
    }
    return subscription.provider === 'stripe' && !!subscription.stripeSubscriptionId;
}

/** Full Premium (monthly/quarterly) — unlimited AI, extension, resume. */
export function isFullPremiumActive(subscription: UserSubscription): boolean {
    if (subscription.plan !== 'premium') {
        return false;
    }
    return isPaidPlanActive(subscription);
}

/** Jobs portal access — Jobs Premium Weekly/Monthly or Full Premium (not part-time only). */
export function isJobsPremiumActive(subscription: UserSubscription): boolean {
    if (subscription.plan !== 'jobs_premium' && subscription.plan !== 'premium') {
        return false;
    }
    return isPaidPlanActive(subscription);
}

/** UK part-time jobs full access — part-time weekly, Jobs Premium, or Full Premium. */
export function isPartTimePremiumActive(subscription: UserSubscription): boolean {
    if (
        subscription.plan !== 'part_time' &&
        subscription.plan !== 'jobs_premium' &&
        subscription.plan !== 'premium'
    ) {
        return false;
    }
    return isPaidPlanActive(subscription);
}

/** Any active paid subscription (blocks duplicate checkout). */
export function hasActivePaidPlan(subscription: UserSubscription): boolean {
    return isPartTimePremiumActive(subscription);
}

/** @deprecated Use isFullPremiumActive — kept for call sites that mean full premium. */
export function isPremiumActive(subscription: UserSubscription): boolean {
    return isFullPremiumActive(subscription);
}

/** Expire paid plans past currentPeriodEnd (e.g. ended subscription). */
export async function refreshSubscriptionIfExpired(
    uid: string,
    preloadedSubscription?: UserSubscription | null
): Promise<UserSubscription> {
    const subscription =
        preloadedSubscription ?? (await getUserBillingDoc(uid)).subscription;
    if (
        (subscription.plan === 'premium' ||
            subscription.plan === 'jobs_premium' ||
            subscription.plan === 'part_time') &&
        subscription.status === 'active' &&
        subscription.currentPeriodEnd
    ) {
        const endMs = subscription.currentPeriodEnd.toMillis();
        if (Date.now() > endMs) {
            const previousPlan = subscription.plan;
            await userRef(uid).set(
                {
                    subscription: {
                        ...subscription,
                        plan: 'free',
                        status: 'expired',
                        lastPaidPlan: previousPlan,
                    },
                },
                { merge: true }
            );
            invalidateBillingStatusCache(uid);
            if (previousPlan === 'premium') {
                const { onFullPremiumAccessEnded } = await import('../email/campaigns');
                void onFullPremiumAccessEnded(uid, subscription.stripeSubscriptionId);
            }
            return { ...subscription, plan: 'free', status: 'expired', lastPaidPlan: previousPlan };
        }
    }
    return subscription;
}

export async function setSubscription(uid: string, subscription: Partial<UserSubscription>): Promise<void> {
    await userRef(uid).set({ subscription }, { merge: true });
    invalidateBillingStatusCache(uid);
}

/**
 * Fix Firestore plan/billingInterval from a known price mapping without calling Stripe.
 * Used when legacy price IDs are registered but Stripe API keys are test/live mismatched.
 */
export async function repairSubscriptionPlanFromPriceId(uid: string): Promise<boolean> {
    const { subscription } = await getUserBillingDoc(uid);
    if (!subscriptionNeedsRepair(subscription)) {
        return false;
    }
    const priceId = subscription.priceId;
    if (!priceId) {
        return false;
    }

    const mapping = await resolvePriceMapping(priceId);
    if (!mapping) {
        return false;
    }

    await setSubscription(uid, {
        plan: mapping.plan,
        billingInterval: mapping.interval,
        provider: subscription.provider === 'none' ? 'stripe' : subscription.provider,
    });
    return true;
}

export type ReserveCommResult =
    | { ok: true; isPremium: true; used: number; limit: number }
    | { ok: true; isPremium: false; used: number; limit: number; remaining: number }
    | {
          ok: false;
          reason: 'COMM_LIMIT_REACHED';
          used: number;
          limit: number;
          remaining: 0;
          message: string;
      };

/**
 * Atomically check free comm quota and increment before calling Gemini (prevents parallel overrun).
 */
export async function reserveCommGeneration(uid: string): Promise<ReserveCommResult> {
    const limit = getFreeCommLimit();
    const subscription = await refreshSubscriptionIfExpired(uid);
    const db = admin.firestore();
    const ref = userRef(uid);

    const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.data() || {};
        const sub = { ...DEFAULT_SUBSCRIPTION, ...(data.subscription || {}) } as UserSubscription;
        const used = typeof data.usage?.commGenerationsTotal === 'number' ? data.usage.commGenerationsTotal : 0;

        if (isPremiumActive(sub)) {
            return { ok: true as const, isPremium: true, used, limit };
        }

        if (used >= limit) {
            return {
                ok: false as const,
                reason: 'COMM_LIMIT_REACHED' as const,
                used,
                limit,
                remaining: 0 as const,
                message: `Free plan includes ${limit} cover letters and emails. Upgrade to Premium for unlimited access while subscribed.`,
            };
        }

        const next = used + 1;
        tx.set(
            ref,
            {
                usage: {
                    commGenerationsTotal: next,
                },
            },
            { merge: true }
        );

        return {
            ok: true as const,
            isPremium: false,
            used: next,
            limit,
            remaining: limit - next,
        };
    });

    if (result.ok && !result.isPremium) {
        invalidateBillingStatusCache(uid);
    }
    return result as ReserveCommResult;
}
export async function refundCommGeneration(uid: string): Promise<void> {
    const subscription = await refreshSubscriptionIfExpired(uid);
    if (isPremiumActive(subscription)) {
        return;
    }

    const db = admin.firestore();
    const ref = userRef(uid);
    let wrote = false;
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.data()?.usage?.commGenerationsTotal ?? 0;
        if (current <= 0) {
            return;
        }
        tx.set(
            ref,
            {
                usage: {
                    commGenerationsTotal: current - 1,
                },
            },
            { merge: true }
        );
        wrote = true;
    });
    if (wrote) invalidateBillingStatusCache(uid);
}

export type ReserveExtCoverLetterResult =
    | { ok: true; isPremium: true; used: number; limit: number }
    | { ok: true; isPremium: false; used: number; limit: number; remaining: number }
    | {
          ok: false;
          reason: 'EXT_COVER_LETTER_LIMIT_REACHED';
          used: number;
          limit: number;
          remaining: 0;
          message: string;
      };

/**
 * Atomically check and increment the extension cover letter quota before calling Gemini.
 * Free users are capped at FREE_EXT_COVER_LETTER_LIMIT (default 5). Premium users are unlimited.
 */
export async function reserveExtensionCoverLetter(uid: string): Promise<ReserveExtCoverLetterResult> {
    const limit = getFreeExtCoverLetterLimit();
    const subscription = await refreshSubscriptionIfExpired(uid);
    const db = admin.firestore();
    const ref = userRef(uid);

    const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.data() || {};
        const sub = { ...DEFAULT_SUBSCRIPTION, ...(data.subscription || {}) } as UserSubscription;
        const used = typeof data.usage?.extensionCoverLetterTotal === 'number'
            ? data.usage.extensionCoverLetterTotal
            : 0;

        if (isPremiumActive(sub)) {
            return { ok: true as const, isPremium: true, used, limit };
        }

        if (used >= limit) {
            return {
                ok: false as const,
                reason: 'EXT_COVER_LETTER_LIMIT_REACHED' as const,
                used,
                limit,
                remaining: 0 as const,
                message: `Free plan includes ${limit} extension cover letters. Upgrade to Premium for unlimited access.`,
            };
        }

        const next = used + 1;
        tx.set(ref, { usage: { extensionCoverLetterTotal: next } }, { merge: true });

        return {
            ok: true as const,
            isPremium: false,
            used: next,
            limit,
            remaining: limit - next,
        };
    });

    if (result.ok && !result.isPremium) {
        invalidateBillingStatusCache(uid);
    }
    return result as ReserveExtCoverLetterResult;
}
export async function refundExtensionCoverLetter(uid: string): Promise<void> {
    const subscription = await refreshSubscriptionIfExpired(uid);
    if (isPremiumActive(subscription)) return;

    const db = admin.firestore();
    const ref = userRef(uid);
    let wrote = false;
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.data()?.usage?.extensionCoverLetterTotal ?? 0;
        if (current <= 0) return;
        tx.set(ref, { usage: { extensionCoverLetterTotal: current - 1 } }, { merge: true });
        wrote = true;
    });
    if (wrote) invalidateBillingStatusCache(uid);
}

export async function getOrCreateStripeCustomerId(
    uid: string,
    email: string | undefined,
    stripeCustomerId?: string
): Promise<string> {
    if (stripeCustomerId) return stripeCustomerId;

    const { subscription } = await getUserBillingDoc(uid);
    if (subscription.stripeCustomerId) return subscription.stripeCustomerId;

    const { getStripe } = await import('./stripeClient');
    const customer = await getStripe().customers.create({
        email: email || undefined,
        metadata: { firebaseUid: uid },
    });

    await setSubscription(uid, {
        stripeCustomerId: customer.id,
        provider: subscription.provider === 'none' ? 'none' : subscription.provider,
        plan: subscription.plan,
        status: subscription.status,
    });

    return customer.id;
}
