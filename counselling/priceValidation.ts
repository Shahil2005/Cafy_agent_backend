import { getStripe } from '../billing/stripeClient';

const REQUIRED_CURRENCY = 'gbp';

/** One-time counselling prices must be GBP — same rule as subscriptions. */
export async function assertGbpCounsellingPrice(priceId: string): Promise<void> {
    const price = await getStripe().prices.retrieve(priceId);

    if (price.type !== 'one_time') {
        throw new Error('PRICE_NOT_ONE_TIME');
    }

    const currency = (price.currency || '').toLowerCase();
    if (currency !== REQUIRED_CURRENCY) {
        throw new Error('PRICE_NOT_GBP');
    }
}
