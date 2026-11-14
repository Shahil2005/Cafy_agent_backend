import * as admin from 'firebase-admin';
import { enqueueOnboardingReminder, enqueuePremiumEndedPair, enqueueVerifyReminder } from './campaigns';
import { isEmailSendingEnabled } from './config';
import { processEmailOutbox } from './worker';
import { isFullPremiumActive, type UserSubscription } from '../billing/subscriptionService';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINBACK_WINDOW_MS = 7 * DAY_MS;

function isFailedPrecondition(err: unknown): boolean {
    const code =
        err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
    const message = err instanceof Error ? err.message : String(err ?? '');
    return code === 'failed-precondition' || message.includes('FAILED_PRECONDITION') || message.includes('requires an index');
}

export async function enqueueDueOnboardingReminders(limit = 50): Promise<{ scanned: number; enqueued: number }> {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - DAY_MS);
    let snap: FirebaseFirestore.QuerySnapshot;
    try {
        snap = await admin
            .firestore()
            .collection('users')
            .where('emails.needsOnboardingReminder', '==', true)
            .where('createdAt', '<=', cutoff)
            .limit(limit)
            .get();
    } catch (err) {
        if (!isFailedPrecondition(err)) throw err;
        console.warn('[email] onboarding reminder index missing; skipping scan');
        return { scanned: 0, enqueued: 0 };
    }

    let enqueued = 0;
    for (const doc of snap.docs) {
        const data = doc.data();
        if (data.onboardingCompleted === true) continue;
        if (data.emails?.unsubscribedAt) continue;
        await enqueueOnboardingReminder(doc.id);
        enqueued += 1;
    }
    return { scanned: snap.size, enqueued };
}

export async function enqueueDueWinbacks(limit = 50): Promise<{ scanned: number; enqueued: number }> {
    let snap: FirebaseFirestore.QuerySnapshot;
    try {
        snap = await admin
            .firestore()
            .collection('users')
            .where('emails.needsWinback', '==', true)
            .limit(limit)
            .get();
    } catch (err) {
        if (!isFailedPrecondition(err)) throw err;
        console.warn('[email] winback index missing; skipping scan');
        return { scanned: 0, enqueued: 0 };
    }

    const now = Date.now();
    let enqueued = 0;
    for (const doc of snap.docs) {
        const data = doc.data();
        const subscription = (data.subscription || {}) as UserSubscription;
        if (isFullPremiumActive(subscription)) continue;
        if (data.emails?.unsubscribedAt) continue;
        const lastPaid = subscription.lastPaidPlan || subscription.plan;
        if (lastPaid !== 'premium') continue;

        const periodEnd = subscription.currentPeriodEnd;
        if (periodEnd && now - periodEnd.toMillis() > WINBACK_WINDOW_MS) continue;
        if (periodEnd && periodEnd.toMillis() > now) continue;

        const subId =
            (typeof data.emails?.winbackStripeSubscriptionId === 'string' &&
                data.emails.winbackStripeSubscriptionId) ||
            subscription.stripeSubscriptionId ||
            null;
        await enqueuePremiumEndedPair(doc.id, subId);
        enqueued += 1;
    }
    return { scanned: snap.size, enqueued };
}

export async function enqueueDueVerifyReminders(limit = 200): Promise<{ scanned: number; enqueued: number }> {
    const stateRef = admin.firestore().doc('emailJobs/verifyReminderScan');
    const state = await stateRef.get();
    const pageToken = typeof state.data()?.pageToken === 'string' ? state.data()?.pageToken : undefined;
    const listed = await admin.auth().listUsers(limit, pageToken);
    const cutoff = Date.now() - DAY_MS;
    let enqueued = 0;

    for (const user of listed.users) {
        if (!user.email || user.emailVerified || user.disabled) continue;
        const created = Date.parse(user.metadata.creationTime || '');
        if (!Number.isFinite(created) || created > cutoff) continue;
        await enqueueVerifyReminder(user.uid);
        enqueued += 1;
    }

    await stateRef.set(
        {
            pageToken: listed.pageToken || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
    );

    return { scanned: listed.users.length, enqueued };
}

export async function runEmailCampaignsCron(): Promise<{
    enabled: boolean;
    onboarding: { scanned: number; enqueued: number };
    winback: { scanned: number; enqueued: number };
    verify: { scanned: number; enqueued: number };
    outbox: Awaited<ReturnType<typeof processEmailOutbox>>;
}> {
    const onboarding = await enqueueDueOnboardingReminders();
    const winback = await enqueueDueWinbacks();
    const verify = await enqueueDueVerifyReminders();
    const outbox = await processEmailOutbox();
    return {
        enabled: isEmailSendingEnabled(),
        onboarding,
        winback,
        verify,
        outbox,
    };
}
