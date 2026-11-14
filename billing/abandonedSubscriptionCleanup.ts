import { getStripe } from './stripeClient';

function invoiceSubscriptionId(inv: {
    parent?: {
        subscription_details?: { subscription?: string | { id?: string } | null } | null;
    } | null;
    subscription?: string | { id?: string } | null;
}): string | null {
    const fromParent = inv.parent?.subscription_details?.subscription;
    if (typeof fromParent === 'string' && fromParent) return fromParent;
    if (fromParent && typeof fromParent === 'object' && fromParent.id) return fromParent.id;

    // Legacy shape (older API versions / expanded objects)
    const legacy = inv.subscription;
    if (typeof legacy === 'string' && legacy) return legacy;
    if (legacy && typeof legacy === 'object' && legacy.id) return legacy.id;
    return null;
}

/**
 * Cancel past_due / unpaid subscriptions and void their open invoices.
 * Prevents Stripe from retrying a failed upgrade charge after the user
 * successfully starts a separate Checkout (e.g. with a promo code).
 */
export async function cancelAbandonedIncompleteSubscriptions(
    customerId: string
): Promise<{ canceledSubscriptionIds: string[]; voidedInvoiceIds: string[] }> {
    const stripe = getStripe();
    const canceledSubscriptionIds: string[] = [];
    const voidedInvoiceIds: string[] = [];

    const [pastDue, unpaid] = await Promise.all([
        stripe.subscriptions.list({ customer: customerId, status: 'past_due', limit: 20 }),
        stripe.subscriptions.list({ customer: customerId, status: 'unpaid', limit: 20 }),
    ]);

    const abandoned = [...pastDue.data, ...unpaid.data];
    if (abandoned.length === 0) {
        return { canceledSubscriptionIds, voidedInvoiceIds };
    }

    const abandonedIds = new Set(abandoned.map((s) => s.id));

    const openInvoices = await stripe.invoices.list({
        customer: customerId,
        status: 'open',
        limit: 20,
    });

    for (const inv of openInvoices.data) {
        const invSub = invoiceSubscriptionId(inv as Parameters<typeof invoiceSubscriptionId>[0]);
        if (!invSub || !abandonedIds.has(invSub)) {
            continue;
        }
        try {
            const voided = await stripe.invoices.voidInvoice(inv.id);
            voidedInvoiceIds.push(voided.id);
        } catch (err) {
            console.warn('[billing] void open invoice failed:', inv.id, err);
        }
    }

    for (const sub of abandoned) {
        try {
            const canceled = await stripe.subscriptions.cancel(sub.id, {
                invoice_now: false,
                prorate: false,
            });
            canceledSubscriptionIds.push(canceled.id);
        } catch (err) {
            console.warn('[billing] cancel abandoned subscription failed:', sub.id, err);
        }
    }

    // Void any invoices that became voidable only after cancel
    const stillOpen = await stripe.invoices.list({
        customer: customerId,
        status: 'open',
        limit: 20,
    });
    for (const inv of stillOpen.data) {
        const invSub = invoiceSubscriptionId(inv as Parameters<typeof invoiceSubscriptionId>[0]);
        if (invSub && canceledSubscriptionIds.includes(invSub)) {
            try {
                const voided = await stripe.invoices.voidInvoice(inv.id);
                if (!voidedInvoiceIds.includes(voided.id)) {
                    voidedInvoiceIds.push(voided.id);
                }
            } catch (err) {
                console.warn('[billing] void invoice after cancel failed:', inv.id, err);
            }
        }
    }

    if (canceledSubscriptionIds.length > 0) {
        console.warn('[billing] canceled abandoned incomplete subscriptions', {
            customerId,
            canceledSubscriptionIds,
            voidedInvoiceIds,
        });
    }

    return { canceledSubscriptionIds, voidedInvoiceIds };
}
