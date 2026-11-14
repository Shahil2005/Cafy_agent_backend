import * as admin from 'firebase-admin';
import { getStripe } from '../billing/stripeClient';
import { cancelUserStripeSubscription } from '../billing/cancelService';
import { getUserBillingDoc } from '../billing/subscriptionService';
import { deleteUserStorageFolder } from '../storageService';
import { writeDeletedUserTombstone, normalizeAccountEmail } from './tombstone';

export const ACCOUNT_DELETE_CONFIRM_PHRASE = 'Delete my Account';

export type AccountDeleteResult = {
    ok: true;
    email: string;
    stripeCancelMode: 'immediate' | 'none' | 'failed';
    storageFilesRemoved: number;
};

function createResumeSupabaseClient() {
    const url = process.env.RESUME_SUPABASE_URL || '';
    const key = process.env.RESUME_SUPABASE_SERVICE_ROLE_KEY || '';
    if (!url || !key) return null;
    // Lazy require keeps delete path working when counselling deps unused.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require('@supabase/supabase-js') as typeof import('@supabase/supabase-js');
    return createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
}

/**
 * Stop all future Stripe collection for this customer on account delete.
 * Policy: cancel immediately, no refunds, no further charges
 * (void open/draft invoices; cancel subs with invoice_now=false + prorate=false;
 * cancel open PaymentIntents).
 */
async function stopAllStripeBillingForCustomer(customerId: string): Promise<void> {
    const stripe = getStripe();

    // 1) Kill collectible invoices first (past_due renewals, upgrade attempts).
    for (const status of ['open', 'draft'] as const) {
        try {
            const invoices = await stripe.invoices.list({
                customer: customerId,
                status,
                limit: 30,
            });
            for (const inv of invoices.data) {
                try {
                    if (status === 'draft') {
                        await stripe.invoices.del(inv.id);
                    } else {
                        await stripe.invoices.voidInvoice(inv.id);
                    }
                } catch (err) {
                    console.warn('[account-delete] invoice stop failed:', inv.id, status, err);
                }
            }
        } catch (err) {
            console.warn('[account-delete] list invoices failed:', status, err);
        }
    }

    // 2) Cancel every live subscription immediately — no final invoice, no prorated refund.
    try {
        const list = await stripe.subscriptions.list({
            customer: customerId,
            status: 'all',
            limit: 30,
        });
        for (const sub of list.data) {
            if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
                continue;
            }
            try {
                // Clear period-end cancel flag if set, then hard-cancel now.
                if (sub.cancel_at_period_end) {
                    try {
                        await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
                    } catch {
                        /* still attempt cancel below */
                    }
                }
                await stripe.subscriptions.cancel(sub.id, {
                    invoice_now: false,
                    prorate: false,
                });
            } catch (err) {
                console.warn('[account-delete] stripe cancel failed:', sub.id, sub.status, err);
            }
        }
    } catch (err) {
        console.warn('[account-delete] list subscriptions failed:', err);
    }

    // 3) Invoices that only became voidable after cancel.
    try {
        const stillOpen = await stripe.invoices.list({
            customer: customerId,
            status: 'open',
            limit: 30,
        });
        for (const inv of stillOpen.data) {
            try {
                await stripe.invoices.voidInvoice(inv.id);
            } catch (err) {
                console.warn('[account-delete] post-cancel void failed:', inv.id, err);
            }
        }
    } catch (err) {
        console.warn('[account-delete] post-cancel invoice list failed:', err);
    }

    // 4) Cancel PaymentIntents still waiting to charge (incomplete checkout / retries).
    try {
        const intents = await stripe.paymentIntents.list({
            customer: customerId,
            limit: 30,
        });
        for (const pi of intents.data) {
            if (
                pi.status === 'requires_payment_method' ||
                pi.status === 'requires_confirmation' ||
                pi.status === 'requires_action' ||
                pi.status === 'requires_capture'
            ) {
                try {
                    await stripe.paymentIntents.cancel(pi.id);
                } catch (err) {
                    console.warn('[account-delete] paymentIntent cancel failed:', pi.id, err);
                }
            }
        }
    } catch (err) {
        console.warn('[account-delete] list paymentIntents failed:', err);
    }

    // 5) Detach saved cards so nothing can charge this customer later.
    try {
        const methods = await stripe.paymentMethods.list({
            customer: customerId,
            limit: 30,
        });
        for (const pm of methods.data) {
            try {
                await stripe.paymentMethods.detach(pm.id);
            } catch (err) {
                console.warn('[account-delete] paymentMethod detach failed:', pm.id, err);
            }
        }
    } catch (err) {
        console.warn('[account-delete] list paymentMethods failed:', err);
    }
}

/** True if Stripe could still charge this customer (live sub or open invoice). */
async function hasLiveStripeBilling(customerId: string): Promise<boolean> {
    const stripe = getStripe();
    const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 30,
    });
    const liveSub = subs.data.some(
        (s) => s.status !== 'canceled' && s.status !== 'incomplete_expired'
    );
    if (liveSub) return true;
    const open = await stripe.invoices.list({
        customer: customerId,
        status: 'open',
        limit: 1,
    });
    return open.data.length > 0;
}

async function resolveStripeCheckoutEmail(customerId: string): Promise<string | null> {
    const stripe = getStripe();
    try {
        const customer = await stripe.customers.retrieve(customerId);
        if (customer.deleted) return null;
        return normalizeAccountEmail(customer.email || '') || null;
    } catch (err) {
        console.warn('[account-delete] stripe customer email lookup failed:', err);
        return null;
    }
}

async function markStripeCustomerDeleted(customerId: string, uid: string): Promise<void> {
    const stripe = getStripe();
    try {
        const customer = await stripe.customers.retrieve(customerId);
        if (customer.deleted) return;
        await stripe.customers.update(customerId, {
            metadata: {
                ...customer.metadata,
                firebaseUid: '',
                cafyDeletedUid: uid,
                cafyDeletedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        console.warn('[account-delete] stripe customer metadata update failed:', err);
    }
}

async function anonymizeCounsellingBookings(uid: string): Promise<void> {
    const db = createResumeSupabaseClient();
    if (!db) return;
    try {
        const { error } = await db
            .from('mentor_bookings')
            .update({
                user_email: null,
                goal: null,
                meeting_url: null,
            })
            .eq('user_id', uid);
        if (error) {
            console.warn('[account-delete] counselling anonymize failed:', error.message);
        }
    } catch (err) {
        console.warn('[account-delete] counselling anonymize error:', err);
    }
}

async function deleteQueryDocs(
    query: FirebaseFirestore.Query
): Promise<number> {
    let removed = 0;
    // Paginate — collection may exceed one batch.
    for (;;) {
        const snap = await query.limit(400).get();
        if (snap.empty) break;
        const batch = admin.firestore().batch();
        for (const doc of snap.docs) {
            batch.delete(doc.ref);
            removed += 1;
        }
        await batch.commit();
        if (snap.size < 400) break;
    }
    return removed;
}

/** Wipe email side stores that sit outside users/{uid}. */
async function scrubEmailSideStores(uid: string, email: string): Promise<void> {
    const db = admin.firestore();
    try {
        const outboxRemoved = await deleteQueryDocs(
            db.collection('emailOutbox').where('uid', '==', uid)
        );
        if (outboxRemoved > 0) {
            console.log('[account-delete] emailOutbox removed:', outboxRemoved);
        }
    } catch (err) {
        console.warn('[account-delete] emailOutbox scrub failed:', err);
    }

    try {
        let feedbackRemoved = await deleteQueryDocs(
            db.collection('emailFeedback').where('uid', '==', uid)
        );
        if (email) {
            feedbackRemoved += await deleteQueryDocs(
                db.collection('emailFeedback').where('email', '==', email)
            );
        }
        if (feedbackRemoved > 0) {
            console.log('[account-delete] emailFeedback removed:', feedbackRemoved);
        }
    } catch (err) {
        console.warn('[account-delete] emailFeedback scrub failed:', err);
    }
}

async function removeRtdbPresence(uid: string): Promise<void> {
    // Admin app is initialised without databaseURL, so pass it explicitly.
    const url = (process.env.FIREBASE_DATABASE_URL || '').trim();
    if (!url) {
        console.warn('[account-delete] FIREBASE_DATABASE_URL not set; rtdb presence remove skipped');
        return;
    }
    try {
        const db = admin.app().database(url);
        await db.ref(`presence/${uid}`).remove();
    } catch (err) {
        // RTDB may be unset in some environments.
        console.warn('[account-delete] rtdb presence remove skipped:', err);
    }
}

/** Retention rows written only after Auth + profile wipe succeed. */
async function writeSuccessfulDeletionRecords(params: {
    uid: string;
    email: string;
    stripeCheckoutEmail: string | null;
    stripeCancelMode: AccountDeleteResult['stripeCancelMode'];
    storageFilesRemoved: number;
}): Promise<void> {
    await writeDeletedUserTombstone({
        email: params.email,
        previousUid: params.uid,
        stripeCheckoutEmail: params.stripeCheckoutEmail,
    });
    try {
        await admin.firestore().collection('accountDeletionEvents').add({
            uid: params.uid,
            email: normalizeAccountEmail(params.email),
            stripeCheckoutEmail: params.stripeCheckoutEmail,
            status: 'completed',
            stripeCancelMode: params.stripeCancelMode,
            storageFilesRemoved: params.storageFilesRemoved,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (err) {
        console.warn('[account-delete] success audit write failed:', err);
    }
}

/**
 * Production account deletion pipeline:
 * Stripe cancel now → storage → counselling PII clear → email side stores → RTDB →
 * Firestore recursive wipe → Auth delete → then tombstone + audit (success only).
 */
export async function deleteUserAccount(params: {
    uid: string;
    email: string;
    confirmationPhrase: string;
}): Promise<AccountDeleteResult> {
    const uid = params.uid;
    const email = normalizeAccountEmail(params.email);
    if (!email) {
        throw new Error('MISSING_EMAIL');
    }
    if (params.confirmationPhrase !== ACCOUNT_DELETE_CONFIRM_PHRASE) {
        throw new Error('CONFIRMATION_MISMATCH');
    }

    const userRef = admin.firestore().doc(`users/${uid}`);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() || {} : {};

    if (userData.legalHold === true || userData.deletionHold === true) {
        throw new Error('LEGAL_HOLD');
    }

    let stripeCancelMode: AccountDeleteResult['stripeCancelMode'] = 'none';
    let stripeCheckoutEmail: string | null = null;

    try {
        await cancelUserStripeSubscription(uid, email, { immediate: true });
        stripeCancelMode = 'immediate';
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message !== 'NO_STRIPE_SUBSCRIPTION') {
            stripeCancelMode = 'failed';
            console.warn('[account-delete] primary stripe cancel:', message);
        }
    }

    // Billing must be fully stopped before any data is wiped: once Auth is gone
    // the user can no longer sign in to cancel, so a leftover sub would keep charging.
    let customerId: string | null = null;
    try {
        const { subscription } = await getUserBillingDoc(uid);
        customerId = subscription.stripeCustomerId || null;
    } catch (err) {
        console.error('[account-delete] billing doc read failed:', err);
        throw new Error('STRIPE_CANCEL_FAILED');
    }
    if (customerId) {
        stripeCheckoutEmail = await resolveStripeCheckoutEmail(customerId);
        // Paid + past_due: immediate cancel, no refund, no further charges.
        await stopAllStripeBillingForCustomer(customerId);
        let stillLive = true;
        try {
            stillLive = await hasLiveStripeBilling(customerId);
        } catch (err) {
            console.error('[account-delete] stripe verify failed:', err);
        }
        if (stillLive) {
            console.error('[account-delete] stripe billing still live, aborting:', customerId);
            throw new Error('STRIPE_CANCEL_FAILED');
        }
        await markStripeCustomerDeleted(customerId, uid);
        stripeCancelMode = 'immediate';
    } else if (stripeCancelMode === 'failed') {
        throw new Error('STRIPE_CANCEL_FAILED');
    }

    let storageFilesRemoved = 0;
    try {
        storageFilesRemoved = await deleteUserStorageFolder(uid);
    } catch (err) {
        console.warn('[account-delete] storage wipe failed:', err);
    }

    await anonymizeCounsellingBookings(uid);
    await scrubEmailSideStores(uid, email);
    await removeRtdbPresence(uid);

    try {
        await admin.firestore().recursiveDelete(userRef);
    } catch (err) {
        console.error('[account-delete] firestore recursiveDelete failed:', err);
        // Fallback: wipe top-level doc so profile PII is gone.
        try {
            await userRef.delete();
        } catch (fallbackErr) {
            console.error('[account-delete] firestore doc delete failed:', fallbackErr);
            throw new Error('FIRESTORE_WIPE_FAILED');
        }
    }

    try {
        await admin.auth().deleteUser(uid);
    } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code !== 'auth/user-not-found') {
            console.error('[account-delete] auth delete failed:', err);
            throw new Error('AUTH_DELETE_FAILED');
        }
    }

    // Only retained Firestore rows: email tombstone(s) + success audit.
    await writeSuccessfulDeletionRecords({
        uid,
        email,
        stripeCheckoutEmail,
        stripeCancelMode,
        storageFilesRemoved,
    });

    return {
        ok: true,
        email,
        stripeCancelMode,
        storageFilesRemoved,
    };
}
