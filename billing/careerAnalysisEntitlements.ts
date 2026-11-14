import * as admin from 'firebase-admin';
import { getFreeCareerAnalysisLifetimeLimit, getPremiumCareerAnalysisDailyLimit } from './config';
import { isFullPremiumActive, refreshSubscriptionIfExpired, type UserSubscription } from './subscriptionService';
import { invalidateBillingStatusCache } from './statusCache';

export type CareerAnalysisTier = 'lifetime' | 'daily' | 'unlimited';

/**
 * Hardcoded allowlist of emails with uncapped Career Path analysis. Bypasses both the
 * free lifetime cap and the Full Premium daily cap: no slot is reserved or incremented
 * for these users, so there is nothing to refund on failure either. Compared
 * lower-cased against the verified Firebase token email.
 */
const UNLIMITED_CAREER_ANALYSIS_EMAILS: ReadonlySet<string> = new Set([
    's.vijaykarthick@gmail.com',
    'shahil.b2023cse@sece.ac.in'
]);

export function hasUnlimitedCareerAnalysis(email?: string | null): boolean {
    return typeof email === 'string' && UNLIMITED_CAREER_ANALYSIS_EMAILS.has(email.trim().toLowerCase());
}

function userRef(uid: string) {
    return admin.firestore().doc(`users/${uid}`);
}

/** UTC calendar day key, e.g. "2026-08-06" — the daily cap resets when this changes. */
function todayUtcDateKey(): string {
    return new Date().toISOString().slice(0, 10);
}

function nextUtcMidnightIso(): string {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return next.toISOString();
}

function readLifetimeCount(data: FirebaseFirestore.DocumentData | undefined): number {
    const n = data?.careerAnalysisUsage?.lifetimeCount;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

function readDailyCount(data: FirebaseFirestore.DocumentData | undefined, todayKey: string): number {
    const daily = data?.careerAnalysisUsage?.daily;
    if (!daily || typeof daily !== 'object') return 0;
    if (daily.dateKey !== todayKey) return 0; // stale day — treat as reset, don't write until reserve
    const n = daily.count;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

export interface CareerAnalysisUsageStatus {
    tier: CareerAnalysisTier;
    used: number;
    /** null == uncapped (allowlisted email). */
    limit: number | null;
    /** null == uncapped (allowlisted email). */
    remaining: number | null;
    allowed: boolean;
    resetAt: string | null;
}

/**
 * Read-only usage status for the Plan & Usage screen and the Career Path tab's own indicator.
 * Never reserves/increments — safe to call on every render. Pass `preloaded` (already-fetched
 * users/{uid} data + subscription, e.g. from buildBillingStatus) to skip a duplicate read.
 */
export async function getCareerAnalysisUsageStatus(
    uid: string,
    preloaded?: { data?: FirebaseFirestore.DocumentData | null; subscription?: UserSubscription | null },
    email?: string | null
): Promise<CareerAnalysisUsageStatus> {
    if (hasUnlimitedCareerAnalysis(email)) {
        return { tier: 'unlimited', used: 0, limit: null, remaining: null, allowed: true, resetAt: null };
    }

    const subscription = preloaded?.subscription ?? (await refreshSubscriptionIfExpired(uid));
    const data = preloaded?.data ?? (await userRef(uid).get()).data() ?? {};
    const isFull = isFullPremiumActive(subscription);

    if (isFull) {
        const limit = getPremiumCareerAnalysisDailyLimit();
        const used = readDailyCount(data, todayUtcDateKey());
        return { tier: 'daily', used, limit, remaining: Math.max(0, limit - used), allowed: used < limit, resetAt: nextUtcMidnightIso() };
    }

    const limit = getFreeCareerAnalysisLifetimeLimit();
    const used = readLifetimeCount(data);
    return { tier: 'lifetime', used, limit, remaining: Math.max(0, limit - used), allowed: used < limit, resetAt: null };
}

export type ReserveCareerAnalysisResult =
    | { ok: true; tier: CareerAnalysisTier; used: number; limit: number | null; remaining: number | null; resetAt: string | null }
    | {
          ok: false;
          reason: 'CAREER_ANALYSIS_LIMIT_REACHED';
          tier: CareerAnalysisTier;
          used: number;
          limit: number;
          remaining: 0;
          resetAt: string | null;
          message: string;
      };

/**
 * Atomically check quota and reserve one slot BEFORE the AI call starts — this is what makes it
 * race-proof: two simultaneous requests can't both pass the check before either write lands,
 * because the transaction serializes them. Call refundCareerAnalysis() if generation then fails,
 * so a failure never costs the user their slot.
 */
export async function reserveCareerAnalysis(uid: string, email?: string | null): Promise<ReserveCareerAnalysisResult> {
    if (hasUnlimitedCareerAnalysis(email)) {
        return { ok: true, tier: 'unlimited', used: 0, limit: null, remaining: null, resetAt: null };
    }

    const subscription = await refreshSubscriptionIfExpired(uid);
    const db = admin.firestore();
    const ref = userRef(uid);
    const isFull = isFullPremiumActive(subscription);

    if (isFull) {
        const limit = getPremiumCareerAnalysisDailyLimit();
        const todayKey = todayUtcDateKey();
        const resetAt = nextUtcMidnightIso();

        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const used = readDailyCount(snap.data(), todayKey);

            if (used >= limit) {
                return {
                    ok: false as const,
                    reason: 'CAREER_ANALYSIS_LIMIT_REACHED' as const,
                    tier: 'daily' as const,
                    used,
                    limit,
                    remaining: 0 as const,
                    resetAt,
                    message: `You've used today's career path analysis. It resets at midnight UTC.`,
                };
            }

            const next = used + 1;
            tx.set(ref, { careerAnalysisUsage: { daily: { count: next, dateKey: todayKey } } }, { merge: true });

            return {
                ok: true as const,
                tier: 'daily' as const,
                used: next,
                limit,
                remaining: limit - next,
                resetAt,
            };
        });

        if (result.ok) invalidateBillingStatusCache(uid);
        return result;
    }

    const limit = getFreeCareerAnalysisLifetimeLimit();
    const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const used = readLifetimeCount(snap.data());

        if (used >= limit) {
            return {
                ok: false as const,
                reason: 'CAREER_ANALYSIS_LIMIT_REACHED' as const,
                tier: 'lifetime' as const,
                used,
                limit,
                remaining: 0 as const,
                resetAt: null,
                message: `Free plan includes ${limit} career path ${limit === 1 ? 'analysis' : 'analyses'}. Upgrade to Premium for daily access.`,
            };
        }

        const next = used + 1;
        tx.set(ref, { careerAnalysisUsage: { lifetimeCount: next } }, { merge: true });

        return {
            ok: true as const,
            tier: 'lifetime' as const,
            used: next,
            limit,
            remaining: limit - next,
            resetAt: null,
        };
    });

    if (result.ok) invalidateBillingStatusCache(uid);
    return result;
}

/** Hands back a reserved slot when generation fails after reservation — never costs the user a slot. */
export async function refundCareerAnalysis(uid: string, tier: CareerAnalysisTier): Promise<void> {
    // Allowlisted (unlimited) users never reserved a slot — nothing to hand back.
    if (tier === 'unlimited') return;

    const db = admin.firestore();
    const ref = userRef(uid);
    let wrote = false;

    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.data();

        if (tier === 'daily') {
            const todayKey = todayUtcDateKey();
            const current = readDailyCount(data, todayKey);
            if (current <= 0) return;
            tx.set(ref, { careerAnalysisUsage: { daily: { count: current - 1, dateKey: todayKey } } }, { merge: true });
            wrote = true;
        } else {
            const current = readLifetimeCount(data);
            if (current <= 0) return;
            tx.set(ref, { careerAnalysisUsage: { lifetimeCount: current - 1 } }, { merge: true });
            wrote = true;
        }
    });

    if (wrote) invalidateBillingStatusCache(uid);
}
