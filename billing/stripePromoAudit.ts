import { getStripe } from './stripeClient';

/**
 * Reads the applied promotion code from a subscription after payment (webhook audit).
 * Checkout may auto-apply a code from the ads funnel (?promo=) or accept a manual Stripe entry.
 */
export async function resolveStripePromotionCode(subscriptionId: string): Promise<string | null> {
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['discounts', 'discounts.promotion_code', 'discount', 'discount.promotion_code'],
    });

    const subAny = sub as {
        discounts?: { data?: Array<{ promotion_code?: string | { code?: string } }> };
        discount?: { promotion_code?: string | { code?: string } };
    };

    const fromExpanded = (pc: string | { code?: string } | undefined): string | null => {
        if (!pc) return null;
        if (typeof pc === 'object' && pc.code) return pc.code;
        return null;
    };

    const discountRows = subAny.discounts?.data ?? [];
    for (const row of discountRows) {
        const label = fromExpanded(row.promotion_code);
        if (label) return label;
        if (typeof row.promotion_code === 'string') {
            const promo = await stripe.promotionCodes.retrieve(row.promotion_code);
            if (promo.code) return promo.code;
        }
    }

    const legacy = subAny.discount?.promotion_code;
    const legacyLabel = fromExpanded(legacy);
    if (legacyLabel) return legacyLabel;
    if (typeof legacy === 'string') {
        const promo = await stripe.promotionCodes.retrieve(legacy);
        return promo.code ?? null;
    }

    return null;
}
