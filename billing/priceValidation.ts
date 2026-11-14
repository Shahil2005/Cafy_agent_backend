import { getStripe } from './stripeClient';

const REQUIRED_CURRENCY = 'gbp';

/**
 * Checkout currency comes from the Stripe Price object — not from the app UI.
 * Reject non-GBP price IDs so users never see INR or other currencies at payment.
 */
export async function assertGbpSubscriptionPrice(priceId: string): Promise<void> {
    const price = await getStripe().prices.retrieve(priceId);

    if (price.type !== 'recurring') {
        throw new Error('PRICE_NOT_SUBSCRIPTION');
    }

    const currency = (price.currency || '').toLowerCase();
    if (currency !== REQUIRED_CURRENCY) {
        throw new Error(
            `PRICE_NOT_GBP: Price ${priceId} is ${currency.toUpperCase()}. ` +
                'Create GBP (£) prices in Stripe and update STRIPE_PRICE_MONTHLY / STRIPE_PRICE_QUARTERLY in .env.'
        );
    }
}
