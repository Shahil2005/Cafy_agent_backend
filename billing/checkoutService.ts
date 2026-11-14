import { getStripe } from './stripeClient';
import { getAllowedPriceIds, getFrontendUrl, getFullPremiumPriceIds, getPartTimePremiumPriceIds } from './config';
import { getResumeToolFrontendUrl } from './config';
import { getOrCreateStripeCustomerId, getUserBillingDoc } from './subscriptionService';
import { assertCanStartNewSubscription } from './subscriptionGuard';
import { assertGbpSubscriptionPrice } from './priceValidation';
import {
    assertStripeHostedUrl,
    resolveBillingPortalConfigurationId,
} from './portalConfig';
import { resolveActivePromotionCodeId } from './promotionCodeResolve';
import { cancelAbandonedIncompleteSubscriptions } from './abandonedSubscriptionCleanup';
import { clearUnexpectedCustomerDebit } from './upgradeRollback';
import { isPartTimeJobsBlocked } from '../jobs-portal/partTimeAccess';
import { randomUUID } from 'crypto';
import * as admin from 'firebase-admin';

export async function createCheckoutSession(
    uid: string,
    email: string | undefined,
    priceId: string,
    options?: {
        onboarding?: boolean;
        returnApp?: 'cafy' | 'resume-tool';
        promotionCode?: string | null;
    }
): Promise<{ url: string; sessionId: string; promoApplied: boolean }> {
    await assertCanStartNewSubscription(uid);

    const allowed = getAllowedPriceIds();
    if (!allowed.includes(priceId)) {
        throw new Error('INVALID_PRICE_ID');
    }

    const partTimePrices = new Set(getPartTimePremiumPriceIds());
    if (partTimePrices.has(priceId)) {
        const userSnap = await admin.firestore().doc(`users/${uid}`).get();
        if (isPartTimeJobsBlocked(userSnap.data() || {})) {
            throw new Error('PART_TIME_UK_ONLY');
        }
    }

    await assertGbpSubscriptionPrice(priceId);

    const { subscription } = await getUserBillingDoc(uid);
    const customerId = await getOrCreateStripeCustomerId(uid, email, subscription.stripeCustomerId ?? undefined);

    // Failed weekly→premium upgrades leave past_due + open invoices. Clear them before
    // starting a fresh Checkout so Stripe does not keep retrying the full list price.
    try {
        await cancelAbandonedIncompleteSubscriptions(customerId);
    } catch (err) {
        console.warn('[billing] abandoned subscription cleanup failed:', err);
    }

    // Same residual-debit trap as in-app upgrades: Stripe Checkout applies positive
    // customer balance onto the session total. Wipe unexpected debit before charge.
    const checkoutAttemptId = randomUUID();
    try {
        await clearUnexpectedCustomerDebit(customerId, checkoutAttemptId, 'checkout');
    } catch (err) {
        console.error('[billing] checkout debit clear failed:', customerId, err);
        throw new Error('BILLING_BALANCE_CLEAR_FAILED');
    }

    const returnApp = options?.returnApp === 'resume-tool' ? 'resume-tool' : 'cafy';
    const frontend = returnApp === 'resume-tool' ? getResumeToolFrontendUrl() : getFrontendUrl();
    const onboarding = options?.onboarding === true;

    const isPromoEligiblePrice = getFullPremiumPriceIds().includes(priceId);
    let resolvedPromo: { promotionCodeId: string; code: string } | null = null;
    if (isPromoEligiblePrice && options?.promotionCode) {
        resolvedPromo = await resolveActivePromotionCodeId(options.promotionCode);
    }

    const baseParams = {
        mode: 'subscription' as const,
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: onboarding
            ? `${frontend}/subscription/success?session_id={CHECKOUT_SESSION_ID}&onboarding=1`
            : `${frontend}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: onboarding
            ? `${frontend}/onboarding/plan?canceled=1`
            : `${returnApp === 'resume-tool' ? `${frontend}/pricing?canceled=1` : `${frontend}/subscription?canceled=1`}`,
        locale: 'en-GB' as const,
        // Do not convert £ prices into INR (or other currencies) based on customer location.
        adaptive_pricing: { enabled: false },
        client_reference_id: uid,
        metadata: {
            firebaseUid: uid,
            ...(resolvedPromo ? { promotionCode: resolvedPromo.code } : {}),
        },
        subscription_data: {
            metadata: {
                firebaseUid: uid,
                ...(resolvedPromo ? { promotionCode: resolvedPromo.code } : {}),
            },
        },
    };

    let session: Awaited<ReturnType<ReturnType<typeof getStripe>['checkout']['sessions']['create']>>;
    let promoApplied = false;

    // Stripe forbids combining discounts with allow_promotion_codes.
    if (resolvedPromo) {
        try {
            session = await getStripe().checkout.sessions.create({
                ...baseParams,
                discounts: [{ promotion_code: resolvedPromo.promotionCodeId }],
            });
            promoApplied = true;
        } catch (error) {
            console.warn(
                '[billing] auto-apply promotion failed; falling back to manual entry:',
                error
            );
            session = await getStripe().checkout.sessions.create({
                ...baseParams,
                allow_promotion_codes: true,
            });
        }
    } else if (isPromoEligiblePrice) {
        session = await getStripe().checkout.sessions.create({
            ...baseParams,
            // Promotion codes are created in Stripe Dashboard; Stripe validates them at Checkout.
            // Premium is granted only after signed webhooks sync the subscription — never from client trust alone.
            allow_promotion_codes: true,
        });
    } else {
        // Jobs weekly / jobs monthly: no promo codes (Full Premium only).
        session = await getStripe().checkout.sessions.create(baseParams);
    }

    if (!session.url) {
        throw new Error('CHECKOUT_URL_MISSING');
    }

    assertStripeHostedUrl(session.url, 'checkout');

    return { url: session.url, sessionId: session.id, promoApplied };
}

export type BillingPortalFlow = 'cancel' | 'update_card';

export async function createPortalSession(
    uid: string,
    email: string | undefined,
    options?: { returnApp?: 'cafy' | 'resume-tool'; flow?: BillingPortalFlow }
): Promise<{ url: string }> {
    const stripe = getStripe();
    const { subscription } = await getUserBillingDoc(uid);
    let customerId = subscription.stripeCustomerId || null;
    if (!customerId && email) {
        const listed = await stripe.customers.list({ email, limit: 5 });
        customerId = listed.data[0]?.id ?? null;
    }
    if (!customerId) {
        throw new Error('NO_STRIPE_CUSTOMER');
    }

    const frontend =
        options?.returnApp === 'resume-tool' ? getResumeToolFrontendUrl() : getFrontendUrl();
    const returnPath =
        options?.returnApp === 'resume-tool' ? '/pricing' : '/subscription?from=portal';
    const returnUrl = `${frontend.replace(/\/$/, '')}${returnPath}`;

    const configuration = await resolveBillingPortalConfigurationId();
    let subscriptionId = subscription.stripeSubscriptionId || null;
    if (options?.flow === 'cancel' && !subscriptionId) {
        const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
        subscriptionId =
            subs.data.find((s) => s.status === 'past_due')?.id ??
            subs.data.find((s) => s.status === 'active' || s.status === 'trialing')?.id ??
            null;
    }

    const base = {
        customer: customerId,
        return_url: returnUrl,
        configuration,
        locale: 'en-GB' as const,
    };
    const openCancelFlow = options?.flow === 'cancel' && Boolean(subscriptionId);
    const openUpdateCardFlow = options?.flow === 'update_card';
    const flowData = openCancelFlow
        ? {
              type: 'subscription_cancel' as const,
              subscription_cancel: { subscription: subscriptionId as string },
              after_completion: {
                  type: 'redirect' as const,
                  redirect: { return_url: returnUrl },
              },
          }
        : openUpdateCardFlow
          ? {
                type: 'payment_method_update' as const,
                after_completion: {
                    type: 'redirect' as const,
                    redirect: { return_url: returnUrl },
                },
            }
          : null;

    let session;
    try {
        session = await stripe.billingPortal.sessions.create(
            flowData ? { ...base, flow_data: flowData } : base
        );
    } catch (err) {
        if (!flowData) throw err;
        // Dedicated portal flows can be blocked (feature off, or unpaid invoice). Still open Stripe.
        session = await stripe.billingPortal.sessions.create(base);
    }

    if (!session.url) {
        throw new Error('PORTAL_URL_MISSING');
    }

    assertStripeHostedUrl(session.url, 'portal');

    return { url: session.url };
}
