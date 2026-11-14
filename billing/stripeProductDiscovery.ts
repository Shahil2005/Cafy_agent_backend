import {
    getJobsMonthlyPriceId,
    getMonthlyPriceId,
    getQuarterlyPriceId,
    getWeeklyPriceId,
} from './config';
import { getStripe, isStripeConfigured } from './stripeClient';

export interface DiscoveredProducts {
    premium: Set<string>;
    jobs: Set<string>;
}

const CACHE_MS = 60 * 60 * 1000;
let cached: { expires: number; products: DiscoveredProducts } | null = null;

function productIdFromPrice(price: { product?: string | { id?: string } | null }): string | null {
    const product = price.product;
    if (!product) return null;
    if (typeof product === 'string') return product;
    return product.id ?? null;
}

async function productIdForPriceId(priceId: string): Promise<string | null> {
    const price = await getStripe().prices.retrieve(priceId);
    return productIdFromPrice(price);
}

/**
 * Resolve Cafy product buckets from env + current checkout price IDs.
 * Products are stable when you create new prices — only price IDs change.
 */
export async function discoverStripeProducts(): Promise<DiscoveredProducts> {
    const now = Date.now();
    if (cached && cached.expires > now) {
        return cached.products;
    }

    const premium = new Set<string>();
    const jobs = new Set<string>();

    const envPremium = process.env.STRIPE_PRODUCT_PREMIUM?.trim();
    const envJobs = process.env.STRIPE_PRODUCT_JOBS?.trim();
    if (envPremium) premium.add(envPremium);
    if (envJobs) jobs.add(envJobs);

    if (!isStripeConfigured()) {
        const products = { premium, jobs };
        cached = { expires: now + CACHE_MS, products };
        return products;
    }

    try {
        const monthlyId = getMonthlyPriceId();
        const quarterlyId = getQuarterlyPriceId();
        const weeklyId = getWeeklyPriceId();
        const jobsMonthlyId = getJobsMonthlyPriceId();

        const [monthlyProduct, quarterlyProduct, weeklyProduct, jobsMonthlyProduct] = await Promise.all([
            monthlyId ? productIdForPriceId(monthlyId).catch(() => null) : null,
            quarterlyId ? productIdForPriceId(quarterlyId).catch(() => null) : null,
            weeklyId ? productIdForPriceId(weeklyId).catch(() => null) : null,
            jobsMonthlyId ? productIdForPriceId(jobsMonthlyId).catch(() => null) : null,
        ]);

        if (monthlyProduct) premium.add(monthlyProduct);
        if (quarterlyProduct) premium.add(quarterlyProduct);
        if (weeklyProduct) jobs.add(weeklyProduct);
        if (jobsMonthlyProduct) jobs.add(jobsMonthlyProduct);
    } catch (err) {
        console.warn('[billing] discoverStripeProducts failed:', err);
    }

    const products = { premium, jobs };
    cached = { expires: now + CACHE_MS, products };
    return products;
}

export function clearStripeProductDiscoveryCache(): void {
    cached = null;
}
