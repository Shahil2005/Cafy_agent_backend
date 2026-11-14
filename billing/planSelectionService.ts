import * as admin from 'firebase-admin';
import {
    refreshSubscriptionIfExpired,
    isFullPremiumActive,
    isJobsPremiumActive,
    parseUserBillingDoc,
    type PreloadedUserDoc,
} from './subscriptionService';
import { priceIdToInterval, resolvePriceMappingSync } from './config';
import { invalidateBillingStatusCache } from './statusCache';

export type ChosenPlan =
    | 'free'
    | 'part_time_weekly'
    | 'weekly'
    | 'jobs_monthly'
    | 'monthly'
    | 'quarterly';

export interface PlanSelection {
    completed: boolean;
    chosenPlan?: ChosenPlan | null;
    completedAt?: string | null;
}

function userRef(uid: string) {
    return admin.firestore().doc(`users/${uid}`);
}

function resolvePreloadedData(preloaded?: PreloadedUserDoc): FirebaseFirestore.DocumentData | null {
    if (!preloaded) return null;
    if (typeof (preloaded as FirebaseFirestore.DocumentSnapshot).data === 'function') {
        return (preloaded as FirebaseFirestore.DocumentSnapshot).data() || {};
    }
    return preloaded as FirebaseFirestore.DocumentData;
}

export function parsePlanSelection(data: FirebaseFirestore.DocumentData | undefined | null): PlanSelection {
    const raw = data?.planSelection;
    if (!raw || typeof raw !== 'object') {
        return { completed: false };
    }
    return {
        completed: raw.completed === true,
        chosenPlan: raw.chosenPlan ?? null,
        completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
    };
}

export async function getPlanSelection(
    uid: string,
    preloaded?: PreloadedUserDoc
): Promise<PlanSelection> {
    const fromPreload = resolvePreloadedData(preloaded);
    if (fromPreload) {
        return parsePlanSelection(fromPreload);
    }
    const snap = await userRef(uid).get();
    return parsePlanSelection(snap.data());
}

function resolveChosenPlanFromSubscription(
    subscription: Awaited<ReturnType<typeof refreshSubscriptionIfExpired>>
): ChosenPlan {
    if (isFullPremiumActive(subscription)) {
        return subscription.billingInterval === 'quarterly' ? 'quarterly' : 'monthly';
    }
    if (isJobsPremiumActive(subscription) && subscription.plan === 'jobs_premium') {
        return subscription.billingInterval === 'monthly' ? 'jobs_monthly' : 'weekly';
    }
    if (subscription.plan === 'part_time' && subscription.status === 'active') {
        return 'part_time_weekly';
    }
    return 'free';
}

/**
 * Resolve plan selection for API responses.
 * - New users: `requiresPlanSelection` is set at onboarding end — must use /onboarding/plan (no auto-fill).
 * - Legacy users: one-time grandfather when onboarding was done before plan picker existed.
 *
 * Pass `preloaded` (snap or data) to avoid a duplicate users/{uid} read in the same request.
 */
export async function ensurePlanSelectionMigrated(
    uid: string,
    preloaded?: PreloadedUserDoc
): Promise<PlanSelection> {
    const fromPreload = resolvePreloadedData(preloaded);
    const data = fromPreload ?? ((await userRef(uid).get()).data() || {});
    const existing = data.planSelection;

    if (existing?.completed === true) {
        return {
            completed: true,
            chosenPlan: existing.chosenPlan ?? null,
            completedAt: existing.completedAt ?? null,
        };
    }

    if (data.requiresPlanSelection === true) {
        return parsePlanSelection(data);
    }

    if (data.planSelectionGrandfathered === true) {
        return parsePlanSelection(data);
    }

    if (data.onboardingCompleted === true) {
        const { subscription: fromData } = parseUserBillingDoc(data);
        const subscription = await refreshSubscriptionIfExpired(uid, fromData);
        const chosenPlan = resolveChosenPlanFromSubscription(subscription);
        const completedAt = new Date().toISOString();
        await userRef(uid).set(
            {
                planSelection: {
                    completed: true,
                    chosenPlan,
                    completedAt,
                    migrated: true,
                },
                planSelectionGrandfathered: true,
            },
            { merge: true }
        );
        invalidateBillingStatusCache(uid);
        return { completed: true, chosenPlan, completedAt };
    }

    return { completed: false };
}

export async function selectFreePlan(uid: string): Promise<PlanSelection> {
    const completedAt = new Date().toISOString();
    const planSelection: PlanSelection = {
        completed: true,
        chosenPlan: 'free',
        completedAt,
    };
    await userRef(uid).set(
        {
            planSelection,
            requiresPlanSelection: false,
        },
        { merge: true }
    );
    invalidateBillingStatusCache(uid);
    return planSelection;
}

export async function completePlanSelectionFromPremium(
    uid: string,
    priceId?: string | null
): Promise<PlanSelection> {
    let chosenPlan: ChosenPlan = 'monthly';
    if (priceId) {
        const mapping = resolvePriceMappingSync(priceId);
        if (mapping?.plan === 'part_time') {
            chosenPlan = 'part_time_weekly';
        } else if (mapping?.plan === 'jobs_premium') {
            chosenPlan = mapping.interval === 'monthly' ? 'jobs_monthly' : 'weekly';
        } else {
            const interval = priceIdToInterval(priceId);
            if (interval === 'quarterly') chosenPlan = 'quarterly';
            else if (interval === 'weekly') chosenPlan = 'weekly';
            else if (interval === 'monthly') chosenPlan = 'monthly';
        }
    }
    const completedAt = new Date().toISOString();
    const planSelection: PlanSelection = {
        completed: true,
        chosenPlan,
        completedAt,
    };
    await userRef(uid).set(
        {
            planSelection,
            requiresPlanSelection: false,
        },
        { merge: true }
    );
    invalidateBillingStatusCache(uid);
    return planSelection;
}
