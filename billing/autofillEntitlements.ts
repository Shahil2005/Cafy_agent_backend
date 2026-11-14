import * as admin from 'firebase-admin';
import { getFreeAutofillLifetimeLimit, getPremiumAutofillDailyLimit, isBillingEnabled } from './config';
import { isFullPremiumActive, refreshSubscriptionIfExpired, type UserSubscription } from './subscriptionService';
import { invalidateBillingStatusCache } from './statusCache';

/**
 * Extension autofill quota and usage.
 *
 * One "autofill" is one run of the extension on an application form. A run can call
 * /api/extension/autofill/fill twice (first to learn which "Add another" buttons to click, then for the
 * answers), so the extension sends its run id and the second call doesn't count again.
 *
 * - Free users (and Jobs / Part-time plans): FREE_AUTOFILL_LIFETIME_LIMIT runs for the account's lifetime
 *   (default 5). Only runs made on the free plan use up the free allowance, so a user who cancels Premium
 *   still has whatever was left.
 * - Full Premium: PREMIUM_AUTOFILL_DAILY_LIMIT runs per day, UK time (default 20). The counter belongs
 *   to the day it was used on, so it starts again from 0 at UK midnight.
 * - Both limits are only ever checked and counted here, on the server, in one transaction: nothing the
 *   extension or website sends can raise them.
 * - Every run is recorded:
 *     users/{uid}.autofillUsage = { total, freeUsed, premiumDay, premiumUsed, firstUsedAt, lastUsedAt }
 *     users/{uid}/autofillRuns/{runId} = { status, plan, premiumDay, host, fieldCount, answered, ... }
 *   Account deletion removes both (recursive delete of users/{uid}).
 * - A run whose answers couldn't be generated is refunded, so a failure never costs an autofill.
 */

/** A run id may be reused for its follow-up request(s) for this long... */
const RUN_REUSE_WINDOW_MS = 30 * 60 * 1000;
/** ...and at most this many requests in total, so one id can't be replayed for free autofills. */
const MAX_REQUESTS_PER_RUN = 3;
/** Ids the extension sends: "<tabId>-<timestamp>". Also safe as a Firestore document id. */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
/** Premium's daily allowance follows the UK calendar day. */
const PREMIUM_DAY_TIME_ZONE = 'Europe/London';

/** "2026-10-31": the calendar day (UK time) a moment falls in. */
export function premiumDayOf(date: Date): string {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: PREMIUM_DAY_TIME_ZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(date);
        const year = parts.find((p) => p.type === 'year')?.value;
        const month = parts.find((p) => p.type === 'month')?.value;
        const day = parts.find((p) => p.type === 'day')?.value;
        if (year && month && day) return `${year}-${month}-${day}`;
    } catch {
        // No time zone data: fall back to UTC below
    }
    return date.toISOString().slice(0, 10);
}

/** "2026-11-01": the day after the given day, when the allowance is replaced by a fresh one. */
function nextDayStart(day: string): string {
    const [year, month, d] = day.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, d + 1)).toISOString().slice(0, 10);
}

function userRef(uid: string) {
    return admin.firestore().doc(`users/${uid}`);
}

function runsCollection(uid: string) {
    return admin.firestore().collection(`users/${uid}/autofillRuns`);
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Runs made on the free plan - the number checked against the lifetime limit. */
function readFreeUsed(data: FirebaseFirestore.DocumentData | undefined): number {
    return count(data?.autofillUsage?.freeUsed);
}

function readTotal(data: FirebaseFirestore.DocumentData | undefined): number {
    return count(data?.autofillUsage?.total);
}

/** Premium runs on the given day; a counter from an earlier day no longer applies. */
function readPremiumUsed(data: FirebaseFirestore.DocumentData | undefined, day: string): number {
    return data?.autofillUsage?.premiumDay === day ? count(data?.autofillUsage?.premiumUsed) : 0;
}

interface Allowance {
    used: number;
    limit: number;
    /** 'lifetime': the free allowance; 'day': Premium's, per calendar day (UK) */
    period: 'lifetime' | 'day';
    /** Premium: the day a new allowance starts (YYYY-MM-DD); free: null */
    resetsOn: string | null;
}

function allowanceFor(isPremium: boolean, data: FirebaseFirestore.DocumentData | undefined, day: string): Allowance {
    if (isPremium) {
        return {
            used: readPremiumUsed(data, day),
            limit: getPremiumAutofillDailyLimit(),
            period: 'day',
            resetsOn: nextDayStart(day),
        };
    }
    return { used: readFreeUsed(data), limit: getFreeAutofillLifetimeLimit(), period: 'lifetime', resetsOn: null };
}

function limitMessage(allowance: Allowance): string {
    if (allowance.period === 'day') {
        return `You've used all ${allowance.limit} autofill credits for today. You'll get ${allowance.limit} more tomorrow.`;
    }
    return `You've used all ${allowance.limit} free autofill credits. Upgrade to Premium for ${getPremiumAutofillDailyLimit()} autofill credits a day.`;
}

export interface AutofillUsageStatus {
    isPremium: boolean;
    /** Runs counted against the current allowance: free (lifetime) or Premium (today) */
    used: number;
    limit: number;
    remaining: number;
    allowed: boolean;
    period: 'lifetime' | 'day';
    /** Premium: the day today's allowance is replaced (YYYY-MM-DD); free: null */
    resetsOn: string | null;
    /** Every run ever, on any plan */
    total: number;
}

/** Read-only status for the extension and the Plan & Usage screen. Never reserves anything. */
export async function getAutofillUsageStatus(
    uid: string,
    preloaded?: { data?: FirebaseFirestore.DocumentData | null; subscription?: UserSubscription | null }
): Promise<AutofillUsageStatus> {
    const subscription = preloaded?.subscription ?? (await refreshSubscriptionIfExpired(uid));
    const data = preloaded?.data ?? (await userRef(uid).get()).data() ?? {};
    const isPremium = isFullPremiumActive(subscription);
    const allowance = allowanceFor(isPremium, data, premiumDayOf(admin.firestore.Timestamp.now().toDate()));
    // With billing switched off (local / staging) nothing is blocked, but usage is still shown
    const allowed = !isBillingEnabled() || allowance.used < allowance.limit;
    return {
        isPremium,
        used: allowance.used,
        limit: allowance.limit,
        remaining: Math.max(0, allowance.limit - allowance.used),
        allowed,
        period: allowance.period,
        resetsOn: allowance.resetsOn,
        total: readTotal(data),
    };
}

export interface AutofillRunInfo {
    /** Page the form is on (host only) */
    host: string | null;
    fieldCount: number;
}

export type ReserveAutofillResult =
    | {
          ok: true;
          /** The run document this request belongs to (pass to complete / refund) */
          runDocId: string;
          /** This request started a new counted run (false: a follow-up request of the same run) */
          counted: boolean;
          isPremium: boolean;
          used: number;
          limit: number;
          remaining: number;
          period: 'lifetime' | 'day';
          resetsOn: string | null;
      }
    | {
          ok: false;
          reason: 'AUTOFILL_LIMIT_REACHED';
          isPremium: boolean;
          used: number;
          limit: number;
          remaining: 0;
          period: 'lifetime' | 'day';
          resetsOn: string | null;
          message: string;
      };

/**
 * Check the quota and count the run BEFORE any AI work, in one transaction - two requests at once can't
 * both slip under the limit. A follow-up request of a run already counted (same run id, same job site,
 * within the reuse window and request cap) is let through without counting again.
 */
export async function reserveAutofillRun(
    uid: string,
    runId: string | undefined,
    info: AutofillRunInfo
): Promise<ReserveAutofillResult> {
    const subscription = await refreshSubscriptionIfExpired(uid);
    const isPremium = isFullPremiumActive(subscription);
    const enforce = isBillingEnabled();
    const db = admin.firestore();
    const ref = userRef(uid);
    const validRunId = typeof runId === 'string' && RUN_ID_PATTERN.test(runId) ? runId : null;

    const result = await db.runTransaction(async (tx) => {
        const runRef = validRunId ? runsCollection(uid).doc(validRunId) : null;
        // All reads before any write (Firestore transactions require it)
        const runSnap = runRef ? await tx.get(runRef) : null;
        const userSnap = await tx.get(ref);
        const now = admin.firestore.Timestamp.now();
        const day = premiumDayOf(now.toDate());
        const allowance = allowanceFor(isPremium, userSnap.data(), day);
        const { used, limit, period, resetsOn } = allowance;

        // Follow-up request of a run that was already counted
        const run = runSnap?.exists ? runSnap.data() : undefined;
        const createdAt = run?.createdAt instanceof admin.firestore.Timestamp ? run.createdAt.toMillis() : 0;
        if (
            runRef &&
            run &&
            run.status !== 'refunded' &&
            now.toMillis() - createdAt <= RUN_REUSE_WINDOW_MS &&
            count(run.requests) < MAX_REQUESTS_PER_RUN &&
            // The same application: a run id can't be carried over to another job site
            (run.host ?? null) === info.host
        ) {
            tx.update(runRef, { requests: count(run.requests) + 1, updatedAt: now });
            return {
                ok: true as const,
                runDocId: runRef.id,
                counted: false,
                isPremium,
                used,
                limit,
                remaining: Math.max(0, limit - used),
                period,
                resetsOn,
            };
        }

        if (enforce && used >= limit) {
            return {
                ok: false as const,
                reason: 'AUTOFILL_LIMIT_REACHED' as const,
                isPremium,
                used,
                limit,
                remaining: 0 as const,
                period,
                resetsOn,
                message: limitMessage(allowance),
            };
        }

        // A new run: count it. A stale or overused id gets a fresh document, so it is counted again.
        const reusable = runRef && !runSnap?.exists;
        const newRunRef = reusable ? runRef : runsCollection(uid).doc();
        const countsAsFree = !isPremium;
        const usage: Record<string, unknown> = {
            total: admin.firestore.FieldValue.increment(1),
            lastUsedAt: now,
        };
        if (countsAsFree) {
            usage.freeUsed = used + 1;
        } else {
            // A new day's counter replaces yesterday's
            usage.premiumDay = day;
            usage.premiumUsed = used + 1;
        }
        if (!userSnap.data()?.autofillUsage?.firstUsedAt) usage.firstUsedAt = now;
        tx.set(ref, { autofillUsage: usage }, { merge: true });
        tx.set(newRunRef, {
            status: 'reserved',
            plan: isPremium ? 'premium' : 'free',
            countsAsFree,
            ...(isPremium ? { premiumDay: day } : {}),
            requests: 1,
            host: info.host,
            fieldCount: info.fieldCount,
            ...(validRunId ? { clientRunId: validRunId } : {}),
            createdAt: now,
            updatedAt: now,
        });

        const usedNow = used + 1;
        return {
            ok: true as const,
            runDocId: newRunRef.id,
            counted: true,
            isPremium,
            used: usedNow,
            limit,
            remaining: Math.max(0, limit - usedNow),
            period,
            resetsOn,
        };
    });

    if (result.ok && result.counted) invalidateBillingStatusCache(uid);
    return result;
}

/** The run's answers were generated: record what came back. Best effort - never fails the request. */
export async function completeAutofillRun(
    uid: string,
    runDocId: string,
    stats: { answered: number; selected: number; uploaded: number; skipped: number }
): Promise<void> {
    try {
        await runsCollection(uid).doc(runDocId).set(
            {
                status: 'completed',
                ...stats,
                completedAt: admin.firestore.Timestamp.now(),
                updatedAt: admin.firestore.Timestamp.now(),
            },
            { merge: true }
        );
    } catch (error) {
        console.warn('[autofill-usage] Could not record the completed run:', error);
    }
}

/**
 * Generating the answers failed: give the autofill back. Only a run that never completed is refunded,
 * and only once (the run is marked refunded in the same transaction).
 */
export async function refundAutofillRun(uid: string, runDocId: string): Promise<void> {
    const db = admin.firestore();
    const ref = userRef(uid);
    const runRef = runsCollection(uid).doc(runDocId);
    let wrote = false;
    try {
        await db.runTransaction(async (tx) => {
            const runSnap = await tx.get(runRef);
            const userSnap = await tx.get(ref);
            const run = runSnap.data();
            if (!run || run.status !== 'reserved') return;
            const now = admin.firestore.Timestamp.now();
            const data = userSnap.data();
            const usage: Record<string, unknown> = { total: Math.max(0, readTotal(data) - 1) };
            if (run.countsAsFree) usage.freeUsed = Math.max(0, readFreeUsed(data) - 1);
            // Premium: only while that day's counter is still the current one
            if (typeof run.premiumDay === 'string' && data?.autofillUsage?.premiumDay === run.premiumDay) {
                usage.premiumUsed = Math.max(0, readPremiumUsed(data, run.premiumDay) - 1);
            }
            tx.set(ref, { autofillUsage: usage }, { merge: true });
            tx.set(runRef, { status: 'refunded', refundedAt: now, updatedAt: now }, { merge: true });
            wrote = true;
        });
    } catch (error) {
        console.error('[autofill-usage] Refund failed:', error);
    }
    if (wrote) invalidateBillingStatusCache(uid);
}

/** "jobs.lever.co" from the page address; null when there's none. */
export function hostOf(url: string | undefined): string | null {
    if (!url) return null;
    try {
        return new URL(url).hostname.slice(0, 200) || null;
    } catch {
        return null;
    }
}
