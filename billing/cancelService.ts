import { getStripe } from './stripeClient';
import { getUserBillingDoc, setSubscription } from './subscriptionService';
import { writeSubscriptionFromStripe } from './stripeSubscriptionSync';

function invoiceSubscriptionId(inv: {
    parent?: {
        subscription_details?: { subscription?: string | { id?: string } | null } | null;
    } | null;
    subscription?: string | { id?: string } | null;
}): string | null {
    const fromParent = inv.parent?.subscription_details?.subscription;
    if (typeof fromParent === 'string' && fromParent) return fromParent;
    if (fromParent && typeof fromParent === 'object' && fromParent.id) return fromParent.id;
    const legacy = inv.subscription;
    if (typeof legacy === 'string' && legacy) return legacy;
    if (legacy && typeof legacy === 'object' && legacy.id) return legacy.id;
    return null;
}

async function voidOpenInvoicesForSubscription(customerId: string, subscriptionId: string): Promise<void> {
    const stripe = getStripe();
    const openInvoices = await stripe.invoices.list({
        customer: customerId,
        status: 'open',
        limit: 20,
    });
    for (const inv of openInvoices.data) {
        const invSub = invoiceSubscriptionId(inv as Parameters<typeof invoiceSubscriptionId>[0]);
        if (invSub && invSub !== subscriptionId) continue;
        try {
            await stripe.invoices.voidInvoice(inv.id);
        } catch (err) {
            console.warn('[billing] void invoice on cancel failed:', inv.id, err);
        }
    }
}

/**
 * Let the user leave a paid Stripe subscription from the app.
 * Past-due / unpaid: void open invoices and cancel immediately (portal "cancel at period end"
 * does not work while a renewal invoice is open).
 * Active: schedule cancel at period end, same as the Stripe portal.
 */
export async function cancelUserStripeSubscription(
    uid: string,
    email?: string,
    options?: { immediate?: boolean }
): Promise<{ mode: 'immediate' | 'period_end' }> {
    const { subscription } = await getUserBillingDoc(uid);
    const stripe = getStripe();
    let customerId = subscription.stripeCustomerId || null;
    let subscriptionId = subscription.stripeSubscriptionId || null;

    // Comped / Firestore-only plans have no Stripe objects — do not look up by email
    // (that can hang, or cancel someone else's live sub on the same address).
    if (!customerId && !subscriptionId && subscription.provider !== 'stripe') {
        if (options?.immediate === true || subscription.status === 'past_due') {
            await setSubscription(uid, {
                provider: 'none',
                plan: 'free',
                status: 'canceled',
                stripeSubscriptionId: null,
                priceId: null,
                billingInterval: null,
                cancelAtPeriodEnd: false,
                stripePromotionCode: null,
            });
            return { mode: 'immediate' };
        }
        throw new Error('NO_STRIPE_SUBSCRIPTION');
    }

    if (!customerId && email) {
        const listed = await stripe.customers.list({ email, limit: 5 });
        customerId = listed.data[0]?.id ?? null;
    }
    if (customerId && !subscriptionId) {
        const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
        subscriptionId =
            list.data.find((s) => s.status === 'past_due' || s.status === 'unpaid' || s.status === 'incomplete')?.id ??
            list.data.find((s) => s.status === 'active' || s.status === 'trialing')?.id ??
            null;
    }
    if (!customerId || !subscriptionId) {
        if (options?.immediate === true || subscription.status === 'past_due') {
            await setSubscription(uid, {
                provider: subscription.provider === 'stripe' ? 'stripe' : 'none',
                plan: 'free',
                status: 'canceled',
                stripeSubscriptionId: null,
                priceId: null,
                billingInterval: null,
                cancelAtPeriodEnd: false,
                stripePromotionCode: null,
            });
            return { mode: 'immediate' };
        }
        throw new Error('NO_STRIPE_SUBSCRIPTION');
    }

    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    if (sub.status === 'canceled') {
        await writeSubscriptionFromStripe(sub as unknown as Parameters<typeof writeSubscriptionFromStripe>[0], uid);
        return { mode: 'immediate' };
    }

    const failed = sub.status === 'past_due' || sub.status === 'unpaid' || sub.status === 'incomplete';
    if (failed || options?.immediate) {
        await voidOpenInvoicesForSubscription(customerId, subscriptionId);
        const canceled = await stripe.subscriptions.cancel(subscriptionId, {
            invoice_now: false,
            prorate: false,
        });
        await writeSubscriptionFromStripe(
            canceled as unknown as Parameters<typeof writeSubscriptionFromStripe>[0],
            uid
        );
        return { mode: 'immediate' };
    }

    const updated = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
    });
    await writeSubscriptionFromStripe(
        updated as unknown as Parameters<typeof writeSubscriptionFromStripe>[0],
        uid
    );
    return { mode: 'period_end' };
}
