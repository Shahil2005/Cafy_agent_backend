import { randomUUID } from 'crypto';
import * as admin from 'firebase-admin';
import { type UserSubscription } from './subscriptionService';
import {
    isResumeToolBillingEnabled,
    getResumeToolLimits,
    type ResumeToolTier,
} from './resumeToolConfig';
import type { ResumeToolOperation } from './resumeToolOperations';
import {
    resolveResumeToolTier,
    resolveResumeToolBucket,
    getResumeToolUsageFromData,
    paidPeriodNeedsReset,
    subscriptionPeriodEndIso,
    isUnlimitedTier,
    type ResumeToolUsageBucket,
    type ResumeToolBucket,
} from './resumeToolEntitlements';
import { invalidateBillingStatusCache } from './statusCache';
import {
    RESUME_RESERVATION_TTL_MS,
    ResumeReservationError,
    assessResumeReservation,
    isResumeReservationId,
} from './resumeToolReservation';

function userRef(uid: string) {
    return admin.firestore().doc(`users/${uid}`);
}

function reservationRef(reservationId: string) {
    return admin.firestore().doc(`resumeToolReservations/${reservationId}`);
}

const DEFAULT_SUB: UserSubscription = {
    provider: 'none',
    plan: 'free',
    status: 'none',
};

function readSubscription(data: Record<string, unknown>): UserSubscription {
    return { ...DEFAULT_SUB, ...(data.subscription || {}) } as UserSubscription;
}

function resetPaidBucket(subscription: UserSubscription): ResumeToolUsageBucket {
    const periodEnd = subscriptionPeriodEndIso(subscription);
    return {
        aiRuns: 0,
        imports: 0,
        pdfDownloads: 0,
        periodStart: new Date().toISOString(),
        periodEnd,
    };
}

function applyPaidPeriodReset(
    paid: ResumeToolUsageBucket,
    subscription: UserSubscription
): ResumeToolUsageBucket {
    if (paidPeriodNeedsReset(paid, subscription)) {
        return resetPaidBucket(subscription);
    }
    return paid;
}

export type ReserveResumeSuccess = {
    ok: true;
    tier: ResumeToolTier;
    bucket: ResumeToolBucket;
    operation: ResumeToolOperation;
    reservationId: string;
    unlimited: boolean;
    used: number;
    limit: number | null;
    remaining: number | null;
    ai?: { used: number; limit: number | null; remaining: number | null };
    import?: { used: number; limit: number | null; remaining: number | null };
};

export type ReserveResumeFailure = {
    ok: false;
    errorCode: 'RESUME_LIMIT_REACHED' | 'BILLING_DISABLED';
    operation: ResumeToolOperation;
    tier: ResumeToolTier;
    bucket: ResumeToolBucket;
    used: number;
    limit: number;
    message: string;
    ai?: { used: number; limit: number };
    import?: { used: number; limit: number };
};

export type ReserveResumeResult = ReserveResumeSuccess | ReserveResumeFailure;

function limitMessage(
    operation: ResumeToolOperation,
    tier: ResumeToolTier
): string {
    if (tier === 'free') {
        if (operation === 'import') {
            return 'Free plan import limit reached. Upgrade to Premium for more imports.';
        }
        if (operation === 'pdf_download') {
            return 'Free plan PDF download limit reached. Upgrade to Premium for unlimited downloads.';
        }
        return 'Free plan AI limit reached (analyse, optimise, and compare score). Upgrade to Premium.';
    }
    if (operation === 'import') {
        return 'Premium import limit reached for this billing period.';
    }
    if (operation === 'pdf_download') {
        return 'Premium PDF download limit reached for this billing period.';
    }
    return 'Premium AI limit reached for this billing period (analyse, optimise, and compare score).';
}

export async function reserveResumeUsage(
    uid: string,
    operation: ResumeToolOperation
): Promise<ReserveResumeResult> {
    if (!isResumeToolBillingEnabled()) {
        return {
            ok: false,
            errorCode: 'BILLING_DISABLED',
            operation,
            tier: 'free',
            bucket: 'free',
            used: 0,
            limit: 0,
            message: 'Resume billing is not enabled.',
        };
    }

    const db = admin.firestore();
    const ref = userRef(uid);

    const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.data() || {};
        const sub = readSubscription(data);
        const tier = resolveResumeToolTier(sub);
        const limits = getResumeToolLimits(tier);
        const buckets = getResumeToolUsageFromData(data);
        let free = buckets.free;
        let paid = applyPaidPeriodReset(buckets.paid, sub);
        const bucketName = resolveResumeToolBucket(tier);
        const usage = bucketName === 'paid' ? paid : free;
        const reservationId = randomUUID();
        const claim = <T extends Record<string, unknown>>(payload: T) => {
            tx.set(reservationRef(reservationId), {
                uid,
                operation,
                expiresAtMs: Date.now() + RESUME_RESERVATION_TTL_MS,
            });
            return { ...payload, reservationId };
        };

        if (isUnlimitedTier(tier)) {
            return claim({
                ok: true as const,
                tier,
                bucket: bucketName,
                operation,
                unlimited: true,
                used: usage.aiRuns,
                limit: null,
                remaining: null,
            });
        }

        const aiLimit = limits.ai;
        const importLimit = limits.import;
        const pdfLimit = limits.pdfDownload;

        if (operation === 'pdf_download') {
            if (pdfLimit !== null && usage.pdfDownloads >= pdfLimit) {
                return {
                    ok: false as const,
                    errorCode: 'RESUME_LIMIT_REACHED' as const,
                    operation,
                    tier,
                    bucket: bucketName,
                    used: usage.pdfDownloads,
                    limit: pdfLimit,
                    message: limitMessage(operation, tier),
                };
            }
            usage.pdfDownloads += 1;
        } else if (operation === 'import') {
            if (importLimit !== null && usage.imports >= importLimit) {
                return {
                    ok: false as const,
                    errorCode: 'RESUME_LIMIT_REACHED' as const,
                    operation,
                    tier,
                    bucket: bucketName,
                    used: usage.imports,
                    limit: importLimit,
                    message: limitMessage(operation, tier),
                    import: { used: usage.imports, limit: importLimit },
                };
            }
            usage.imports += 1;
        } else {
            // analyse | optimise
            if (aiLimit !== null && usage.aiRuns >= aiLimit) {
                return {
                    ok: false as const,
                    errorCode: 'RESUME_LIMIT_REACHED' as const,
                    operation,
                    tier,
                    bucket: bucketName,
                    used: usage.aiRuns,
                    limit: aiLimit,
                    message: limitMessage(operation, tier),
                    ai: { used: usage.aiRuns, limit: aiLimit },
                };
            }
            usage.aiRuns += 1;
        }

        if (bucketName === 'paid') {
            paid = usage;
        } else {
            free = usage;
        }

        tx.set(
            ref,
            {
                usage: {
                    resumeTool: { free, paid },
                },
            },
            { merge: true }
        );

        const aiUsed = usage.aiRuns;
        const importUsed = usage.imports;
        const pdfUsed = usage.pdfDownloads;

        let used = aiUsed;
        let limit: number | null = aiLimit;
        let remaining: number | null = aiLimit === null ? null : Math.max(0, aiLimit - aiUsed);

        if (operation === 'pdf_download') {
            used = pdfUsed;
            limit = pdfLimit;
            remaining = pdfLimit === null ? null : Math.max(0, pdfLimit - pdfUsed);
        } else if (operation === 'import') {
            used = importUsed;
            limit = importLimit;
            remaining = importLimit === null ? null : Math.max(0, importLimit - importUsed);
        }

        return claim({
            ok: true as const,
            tier,
            bucket: bucketName,
            operation,
            unlimited: false,
            used,
            limit,
            remaining,
            ai:
                aiLimit === null
                    ? { used: aiUsed, limit: null, remaining: null }
                    : { used: aiUsed, limit: aiLimit, remaining: Math.max(0, aiLimit - aiUsed) },
            import:
                importLimit === null
                    ? { used: importUsed, limit: null, remaining: null }
                    : {
                          used: importUsed,
                          limit: importLimit,
                          remaining: Math.max(0, importLimit - importUsed),
                      },
        });
    });

    // Usage counters only change on non-unlimited successful reserves.
    if (result.ok && result.unlimited !== true) {
        invalidateBillingStatusCache(uid);
    }
    return result;
}

export async function refundResumeUsage(
    uid: string,
    operation: ResumeToolOperation,
    reservationId: string
): Promise<void> {
    if (!isResumeToolBillingEnabled()) {
        return;
    }
    if (!isResumeReservationId(reservationId)) {
        throw new ResumeReservationError();
    }

    const db = admin.firestore();
    const ref = userRef(uid);
    const resRef = reservationRef(reservationId);

    const outcome = await db.runTransaction(async (tx) => {
        const resSnap = await tx.get(resRef);
        const snap = await tx.get(ref);
        const reservation = resSnap.exists ? resSnap.data() : null;
        if (assessResumeReservation(reservation, uid, operation, Date.now()) !== 'ok') {
            const expired =
                reservation?.uid === uid &&
                typeof reservation.expiresAtMs === 'number' &&
                reservation.expiresAtMs <= Date.now();
            if (expired) tx.delete(resRef);
            return 'invalid' as const;
        }

        tx.delete(resRef);

        const data = snap.data() || {};
        const sub = readSubscription(data);
        const tier = resolveResumeToolTier(sub);
        if (isUnlimitedTier(tier)) {
            return 'ok' as const;
        }

        const buckets = getResumeToolUsageFromData(data);
        let free = buckets.free;
        let paid = applyPaidPeriodReset(buckets.paid, sub);
        const bucketName = resolveResumeToolBucket(tier);
        const usage = bucketName === 'paid' ? paid : free;

        if (operation === 'pdf_download') {
            usage.pdfDownloads = Math.max(0, usage.pdfDownloads - 1);
        } else if (operation === 'import') {
            usage.imports = Math.max(0, usage.imports - 1);
        } else {
            usage.aiRuns = Math.max(0, usage.aiRuns - 1);
        }

        if (bucketName === 'paid') {
            paid = usage;
        } else {
            free = usage;
        }

        tx.set(
            ref,
            {
                usage: {
                    resumeTool: { free, paid },
                },
            },
            { merge: true }
        );
        return 'changed' as const;
    });

    if (outcome === 'invalid') {
        throw new ResumeReservationError();
    }
    if (outcome === 'changed') {
        invalidateBillingStatusCache(uid);
    }
}
