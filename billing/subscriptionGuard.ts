import { getStripe, isStripeConfigured } from './stripeClient';
import {
    refreshSubscriptionIfExpired,
    hasActivePaidPlan,
    repairSubscriptionPlanFromPriceId,
} from './subscriptionService';
import { syncUserSubscriptionFromStripe } from './stripeSubscriptionSync';
import { subscriptionNeedsRepair } from './priceRegistry';

/**
 * Blocks new Stripe Checkout if the user already has an active paid plan
 * (Firestore or Stripe — whichever indicates an active subscription).
 */
export async function assertCanStartNewSubscription(uid: string): Promise<void> {
    let subscription = await refreshSubscriptionIfExpired(uid);

    if (
        subscriptionNeedsRepair({
            status: subscription.status,
            plan: subscription.plan,
            billingInterval: subscription.billingInterval ?? null,
            priceId: subscription.priceId ?? null,
            stripeSubscriptionId: subscription.stripeSubscriptionId ?? null,
        })
    ) {
        try {
            await syncUserSubscriptionFromStripe(uid);
            subscription = await refreshSubscriptionIfExpired(uid);
        } catch (err) {
            console.warn('[billing] auto-repair before checkout guard failed:', err);
            try {
                await repairSubscriptionPlanFromPriceId(uid);
                subscription = await refreshSubscriptionIfExpired(uid);
            } catch (repairErr) {
                console.warn('[billing] Firestore plan repair before checkout failed:', repairErr);
            }
        }
    }

    if (hasActivePaidPlan(subscription)) {
        throw new Error('ALREADY_SUBSCRIBED');
    }

    if (!isStripeConfigured() || !subscription.stripeCustomerId) {
        return;
    }

    try {
        const stripe = getStripe();
        const [active, trialing] = await Promise.all([
            stripe.subscriptions.list({
                customer: subscription.stripeCustomerId,
                status: 'active',
                limit: 5,
            }),
            stripe.subscriptions.list({
                customer: subscription.stripeCustomerId,
                status: 'trialing',
                limit: 5,
            }),
        ]);

        if (active.data.length > 0 || trialing.data.length > 0) {
            throw new Error('ALREADY_SUBSCRIBED');
        }
        // past_due is intentionally not blocking here — createCheckoutSession clears
        // abandoned incomplete subscriptions before opening a new Checkout session.
    } catch (err: unknown) {
        if (err instanceof Error && err.message === 'ALREADY_SUBSCRIBED') {
            throw err;
        }
        console.error('[billing] Stripe subscription check failed:', err);
        // If Firestore says not premium, allow checkout when Stripe check fails (avoid blocking sales)
    }
}
