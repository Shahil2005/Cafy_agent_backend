import * as admin from 'firebase-admin';
import { isFullPremiumActive, type UserSubscription } from '../billing/subscriptionService';
import { firstNameFromDisplayName } from './names';

export interface UserEmailProfile {
    uid: string;
    email: string | null;
    displayName: string | null;
    firstName: string;
    onboardingCompleted: boolean;
    unsubscribed: boolean;
    needsOnboardingReminder: boolean;
    needsWinback: boolean;
    lastPaidPlan: string | null;
    fullPremiumActive: boolean;
    createdAt: admin.firestore.Timestamp | null;
    campaigns: Record<string, { sentAt?: admin.firestore.Timestamp | null }>;
}

function emailsMap(data: FirebaseFirestore.DocumentData | undefined) {
    return (data?.emails || {}) as Record<string, unknown>;
}

export async function ensureUserStub(params: {
    uid: string;
    email?: string | null;
    displayName?: string | null;
}): Promise<void> {
    const ref = admin.firestore().doc(`users/${params.uid}`);
    const snap = await ref.get();
    const existing = snap.data() || {};
    const emails = emailsMap(existing);
    const patch: Record<string, unknown> = {};

    if (!existing.email && params.email) patch.email = params.email;
    if (!existing.displayName && params.displayName) patch.displayName = params.displayName;
    if (existing.onboardingCompleted !== true && existing.onboardingCompleted !== false) {
        patch.onboardingCompleted = false;
    }
    if (!existing.createdAt) {
        patch.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }
    if (!existing.emails) {
        patch.emails = {
            marketingOptIn: true,
            unsubscribedAt: null,
            needsOnboardingReminder: existing.onboardingCompleted !== true,
            needsWinback: false,
        };
    } else {
        if (emails.marketingOptIn === undefined) {
            patch['emails.marketingOptIn'] = true;
        }
        if (
            existing.onboardingCompleted !== true &&
            emails.needsOnboardingReminder === undefined &&
            !emails.unsubscribedAt
        ) {
            patch['emails.needsOnboardingReminder'] = true;
        }
    }

    if (Object.keys(patch).length === 0) return;
    await ref.set(patch, { merge: true });
}

export async function loadUserEmailProfile(uid: string): Promise<UserEmailProfile> {
    const snap = await admin.firestore().doc(`users/${uid}`).get();
    const data = snap.data() || {};
    const emails = emailsMap(data);
    let email = typeof data.email === 'string' ? data.email : null;
    let displayName = typeof data.displayName === 'string' ? data.displayName : null;

    if (!email) {
        try {
            const authUser = await admin.auth().getUser(uid);
            email = authUser.email || null;
            displayName = displayName || authUser.displayName || null;
        } catch {
            // Auth record may already be deleted.
        }
    }

    const campaigns = (emails.campaigns || {}) as UserEmailProfile['campaigns'];
    const lastPaidPlan =
        typeof data.subscription?.lastPaidPlan === 'string' ? data.subscription.lastPaidPlan : null;

    return {
        uid,
        email,
        displayName,
        firstName: firstNameFromDisplayName(displayName),
        onboardingCompleted: data.onboardingCompleted === true,
        unsubscribed: Boolean(emails.unsubscribedAt),
        needsOnboardingReminder: emails.needsOnboardingReminder === true,
        needsWinback: emails.needsWinback === true,
        lastPaidPlan,
        fullPremiumActive: isFullPremiumActive((data.subscription || {}) as UserSubscription),
        createdAt: data.createdAt instanceof admin.firestore.Timestamp ? data.createdAt : null,
        campaigns,
    };
}

export async function markUnsubscribed(uid: string): Promise<void> {
    await admin.firestore().doc(`users/${uid}`).set(
        {
            emails: {
                unsubscribedAt: admin.firestore.FieldValue.serverTimestamp(),
                marketingOptIn: false,
                needsOnboardingReminder: false,
                needsWinback: false,
            },
        },
        { merge: true }
    );
}

export async function clearOnboardingReminder(uid: string): Promise<void> {
    await admin.firestore().doc(`users/${uid}`).set(
        {
            emails: {
                needsOnboardingReminder: false,
            },
        },
        { merge: true }
    );
}

export async function markWinbackNeeded(
    uid: string,
    lastPaidPlan: 'premium',
    stripeSubscriptionId?: string | null
): Promise<void> {
    await admin.firestore().doc(`users/${uid}`).set(
        {
            subscription: { lastPaidPlan },
            emails: {
                needsWinback: true,
                winbackStripeSubscriptionId: stripeSubscriptionId || null,
            },
        },
        { merge: true }
    );
}

export async function clearWinbackNeeded(uid: string): Promise<void> {
    await admin.firestore().doc(`users/${uid}`).set(
        {
            emails: { needsWinback: false },
        },
        { merge: true }
    );
}
