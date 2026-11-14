import * as admin from 'firebase-admin';
import { getStripe } from './stripeClient';
import { getUserBillingDoc, setSubscription } from './subscriptionService';
import { resolvePriceMapping } from './priceRegistry';
import { writeSubscriptionFromStripe } from './stripeSubscriptionSync';
import { createResumeSupabaseClient } from '../lib/mentorStorage';
import {
    handleCounsellingCheckoutCompleted,
    isCounsellingCheckoutSession,
} from '../counselling/paymentWebhook';
import { rollbackFailedWeeklyUpgradeFromInvoice, clearUpgradePendingMetadata } from './upgradeRollback';
import { sendGaPurchase } from '../analytics/ga4';

/** Stripe subscription object from API / webhooks */
interface StripeSubscriptionPayload {
    id: string;
    status: string;
    metadata?: { firebaseUid?: string };
    customer: string | { id?: string };
    items: { data: Array<{ price?: { id?: string }; current_period_end?: number }> };
    billing_cycle_anchor?: number;
    cancel_at_period_end: boolean;
}

interface CheckoutSessionPayload {
    id?: string;
    client_reference_id?: string | null;
    metadata?: { firebaseUid?: string; type?: string; reservationId?: string };
    subscription?: string | null;
    payment_status?: string | null;
    customer_details?: { email?: string | null } | null;
    payment_intent?: string | { id?: string } | null;
    amount_total?: number | null;
    currency?: string | null;
    invoice?: string | { id?: string } | null;
}

interface InvoicePayload {
    id?: string;
    status?: string | null;
    billing_reason?: string | null;
    amount_paid?: number | null;
    currency?: string | null;
    parent?: {
        subscription_details?: { subscription?: string | { id?: string } | null } | null;
    } | null;
    subscription?: string | { id?: string } | null;
}

function invoiceSubscriptionId(invoice: InvoicePayload): string | null {
    const fromParent = invoice.parent?.subscription_details?.subscription;
    if (typeof fromParent === 'string' && fromParent) return fromParent;
    if (fromParent && typeof fromParent === 'object' && fromParent.id) return fromParent.id;
    const legacy = invoice.subscription;
    if (typeof legacy === 'string' && legacy) return legacy;
    if (legacy && typeof legacy === 'object' && legacy.id) return legacy.id;
    return null;
}

async function isEventProcessed(eventId: string): Promise<boolean> {
    const ref = admin.firestore().doc(`billing_events/${eventId}`);
    const snap = await ref.get();
    return snap.exists;
}

async function markEventProcessed(eventId: string, type: string, uid?: string): Promise<void> {
    await admin.firestore().doc(`billing_events/${eventId}`).set({
        type,
        uid: uid || null,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

/** Skip recreating billing docs after account deletion (user doc gone). */
async function isDeletedAccountUid(uid: string | null | undefined): Promise<boolean> {
    if (!uid) return true;
    const snap = await admin.firestore().doc(`users/${uid}`).get();
    return !snap.exists;
}

async function resolveUidFromSubscription(sub: StripeSubscriptionPayload): Promise<string | null> {
    if (sub.metadata?.firebaseUid) {
        if (await isDeletedAccountUid(sub.metadata.firebaseUid)) return null;
        return sub.metadata.firebaseUid;
    }
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    if (!customerId) return null;
    const snap = await admin
        .firestore()
        .collection('users')
        .where('subscription.stripeCustomerId', '==', customerId)
        .limit(1)
        .get();
    if (!snap.empty) {
        const uid = snap.docs[0].id;
        if (await isDeletedAccountUid(uid)) return null;
        return uid;
    }
    const customer = await getStripe().customers.retrieve(customerId);
    if (!customer.deleted) {
        if (customer.metadata?.cafyDeletedAt) return null;
        if (customer.metadata?.firebaseUid) {
            if (await isDeletedAccountUid(customer.metadata.firebaseUid)) return null;
            return customer.metadata.firebaseUid;
        }
    }
    return null;
}

async function handleCheckoutCompleted(session: CheckoutSessionPayload): Promise<void> {
    if (isCounsellingCheckoutSession(session as Parameters<typeof isCounsellingCheckoutSession>[0])) {
        const resumeSupabase = createResumeSupabaseClient();
        await handleCounsellingCheckoutCompleted(
            resumeSupabase,
            session as Parameters<typeof handleCounsellingCheckoutCompleted>[1]
        );
        const counsellingUid = session.client_reference_id || session.metadata?.firebaseUid;
        if (counsellingUid && session.payment_status === 'paid' && session.id) {
            await sendGaPurchase(counsellingUid, {
                transactionId: session.id,
                valuePence: session.amount_total ?? 0,
                currency: session.currency || 'gbp',
                itemId: 'career_counselling',
                itemName: 'Career counselling session',
                purchaseType: 'counselling',
            });
        }
        return;
    }

    const uid =
        session.client_reference_id ||
        session.metadata?.firebaseUid ||
        null;
    if (!uid) {
        console.warn('[billing] checkout.session.completed without uid');
        return;
    }
    if (await isDeletedAccountUid(uid)) {
        console.warn('[billing] checkout.session.completed ignored for deleted account', uid);
        return;
    }

    if (session.subscription && typeof session.subscription === 'string') {
        const sub = await getStripe().subscriptions.retrieve(session.subscription);
        await writeSubscriptionFromStripe(sub as unknown as StripeSubscriptionPayload, uid);
        try {
            const { enqueuePurchaseGuideFromSubscription } = await import('../email/purchaseGuide');
            await enqueuePurchaseGuideFromSubscription(uid, sub.id);
        } catch (err) {
            console.error('[email] purchase guide enqueue failed:', err);
        }
        // GA4 purchase for the first payment. Keyed by the invoice, as renewals are (invoice.paid).
        if (session.payment_status === 'paid') {
            const priceId = sub.items?.data?.[0]?.price?.id ?? 'subscription';
            const invoiceId = typeof session.invoice === 'string' ? session.invoice : session.invoice?.id;
            await sendGaPurchase(uid, {
                transactionId: invoiceId || session.id || '',
                valuePence: session.amount_total ?? 0,
                currency: session.currency || 'gbp',
                itemId: priceId,
                itemName: (await resolvePriceMapping(priceId))?.plan ?? 'subscription',
                purchaseType: 'subscription',
            });
        }
    }
}

export async function handleStripeWebhook(
    rawBody: Buffer,
    signature: string | undefined
): Promise<{ received: boolean }> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
        throw new Error('STRIPE_WEBHOOK_SECRET missing');
    }
    if (!signature) {
        throw new Error('Missing stripe-signature header');
    }

    const event = getStripe().webhooks.constructEvent(rawBody, signature, secret);

    if (await isEventProcessed(event.id)) {
        return { received: true };
    }

    let uid: string | undefined;

    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object as CheckoutSessionPayload;
            uid = session.client_reference_id || session.metadata?.firebaseUid || undefined;
            await handleCheckoutCompleted(session);
            break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
            const sub = event.data.object as unknown as StripeSubscriptionPayload;
            uid = (await resolveUidFromSubscription(sub)) || undefined;
            if (uid) await writeSubscriptionFromStripe(sub, uid);
            break;
        }
        case 'customer.subscription.deleted': {
            const sub = event.data.object as unknown as StripeSubscriptionPayload;
            uid = (await resolveUidFromSubscription(sub)) || undefined;
            if (uid) {
                const { subscription: existing } = await getUserBillingDoc(uid);
                const previousPlan = existing.plan === 'premium' ? 'premium' : existing.lastPaidPlan;
                await setSubscription(uid, {
                    provider: 'stripe',
                    plan: 'free',
                    status: 'canceled',
                    stripeSubscriptionId: null,
                    cancelAtPeriodEnd: false,
                    lastPaidPlan:
                        previousPlan === 'premium' ||
                        previousPlan === 'jobs_premium' ||
                        previousPlan === 'part_time'
                            ? previousPlan
                            : existing.lastPaidPlan,
                });
                if (previousPlan === 'premium') {
                    const { onFullPremiumAccessEnded } = await import('../email/campaigns');
                    void onFullPremiumAccessEnded(uid, sub.id);
                }
            }
            break;
        }
        case 'invoice.paid': {
            const invoice = event.data.object as InvoicePayload;
            // Crash between successful upgrade charge and metadata clear must not leave
            // pending=1 (which would let a later payment_failed demote Premium).
            if (invoice.billing_reason === 'subscription_update') {
                const subId = invoiceSubscriptionId(invoice);
                if (subId) {
                    try {
                        await clearUpgradePendingMetadata(subId);
                        const sub = await getStripe().subscriptions.retrieve(subId);
                        uid =
                            (await resolveUidFromSubscription(
                                sub as unknown as StripeSubscriptionPayload
                            )) || undefined;
                    } catch (err) {
                        console.warn('[billing] clear upgrade pending after invoice.paid failed:', err);
                    }
                }
            }
            // GA4 purchase for renewals and upgrades. First payments are sent from
            // checkout.session.completed (billing_reason subscription_create is skipped here).
            // Requires invoice.paid to be enabled on the Stripe webhook endpoint.
            if (
                (invoice.billing_reason === 'subscription_cycle' || invoice.billing_reason === 'subscription_update') &&
                (invoice.amount_paid ?? 0) > 0 &&
                invoice.id
            ) {
                try {
                    const subId = invoiceSubscriptionId(invoice);
                    const sub = subId ? await getStripe().subscriptions.retrieve(subId) : null;
                    const payer =
                        uid || (sub ? await resolveUidFromSubscription(sub as unknown as StripeSubscriptionPayload) : null);
                    if (payer) {
                        uid = payer;
                        const priceId = sub?.items?.data?.[0]?.price?.id ?? 'subscription';
                        await sendGaPurchase(payer, {
                            transactionId: invoice.id,
                            valuePence: invoice.amount_paid ?? 0,
                            currency: invoice.currency || 'gbp',
                            itemId: priceId,
                            itemName: (await resolvePriceMapping(priceId))?.plan ?? 'subscription',
                            purchaseType: 'subscription_renewal',
                        });
                    }
                } catch (err) {
                    console.warn('[ga4] renewal purchase failed:', err);
                }
            }
            break;
        }
        case 'invoice.payment_failed': {
            const invoice = event.data.object as InvoicePayload;

            // Failed weekly → Full Premium upgrades: put user back on weekly immediately
            // so Stripe stops retrying the full list-price invoice.
            const upgradeRollback = await rollbackFailedWeeklyUpgradeFromInvoice(invoice);
            if (upgradeRollback.rolledBack) {
                uid = upgradeRollback.uid;
                break;
            }

            const subId = invoiceSubscriptionId(invoice);
            if (subId) {
                const sub = await getStripe().subscriptions.retrieve(subId);
                uid = (await resolveUidFromSubscription(sub as unknown as StripeSubscriptionPayload)) || undefined;
                if (uid) {
                    const { subscription: existing } = await getUserBillingDoc(uid);
                    const priceId = sub.items?.data?.[0]?.price?.id ?? existing.priceId ?? null;
                    const mappedPlan = priceId ? (await resolvePriceMapping(priceId))?.plan ?? null : null;
                    const plan =
                        mappedPlan === 'jobs_premium' ||
                        mappedPlan === 'premium' ||
                        mappedPlan === 'part_time'
                            ? mappedPlan
                            : existing.plan === 'jobs_premium' ||
                                existing.plan === 'part_time' ||
                                existing.plan === 'premium'
                              ? existing.plan
                              : 'premium';
                    await setSubscription(uid, {
                        provider: 'stripe',
                        plan,
                        status: 'past_due',
                        stripeSubscriptionId: sub.id,
                        priceId,
                    });
                }
            }
            break;
        }
        default:
            break;
    }

    await markEventProcessed(event.id, event.type, uid);
    return { received: true };
}
