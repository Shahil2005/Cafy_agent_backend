import { getStripe, isStripeConfigured } from './stripeClient';
import {
    getJobsMonthlyPriceId,
    getMonthlyPriceId,
    getPartTimeWeeklyPriceId,
    getQuarterlyPriceId,
    getWeeklyPriceId,
} from './config';
import { getStoredPriceMapping, storePriceMapping } from './priceMappingStore';
import { discoverStripeProducts, clearStripeProductDiscoveryCache } from './stripeProductDiscovery';

export type MappedPlan = 'part_time' | 'jobs_premium' | 'premium';
export type MappedInterval = 'weekly' | 'monthly' | 'quarterly';

export interface PriceMapping {
    plan: MappedPlan;
    interval: MappedInterval;
}

const CACHE_MS = 60 * 60 * 1000;
const NEGATIVE_CACHE_MS = 5 * 60 * 1000;

const stripeCache = new Map<string, { mapping: PriceMapping | null; expires: number }>();

function parseCommaList(raw: string | undefined): string[] {
    if (!raw?.trim()) return [];
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseRegistryJson(): Map<string, PriceMapping> {
    const out = new Map<string, PriceMapping>();
    const raw = process.env.STRIPE_PRICE_REGISTRY_JSON;
    if (!raw?.trim()) return out;
    try {
        const parsed = JSON.parse(raw) as Record<string, { plan?: string; interval?: string }>;
        for (const [priceId, entry] of Object.entries(parsed)) {
            const mapping = normalizeMapping(entry?.plan, entry?.interval);
            if (mapping) out.set(priceId, mapping);
        }
    } catch (err) {
        console.error('[billing] STRIPE_PRICE_REGISTRY_JSON invalid:', err);
    }
    return out;
}

function counsellingPriceIds(): Set<string> {
    const ids = new Set<string>();
    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('STRIPE_PRICE_COUNSELLING_') && value?.trim()) {
            ids.add(value.trim());
        }
    }
    return ids;
}

const COUNSELLING_IDS = counsellingPriceIds();

function normalizePlan(raw: unknown): MappedPlan | null {
    const v = String(raw ?? '')
        .trim()
        .toLowerCase();
    if (v === 'premium' || v === 'full' || v === 'full_premium') return 'premium';
    if (v === 'jobs_premium' || v === 'jobs' || v === 'jobs_only' || v === 'weekly') {
        return 'jobs_premium';
    }
    if (
        v === 'part_time' ||
        v === 'parttime' ||
        v === 'part_time_premium' ||
        v === 'part_time_weekly'
    ) {
        return 'part_time';
    }
    return null;
}

function normalizeInterval(raw: unknown): MappedInterval | null {
    const v = String(raw ?? '')
        .trim()
        .toLowerCase();
    if (v === 'weekly' || v === 'week') return 'weekly';
    if (v === 'monthly' || v === 'month') return 'monthly';
    if (v === 'quarterly' || v === 'quarter' || v === '3_month' || v === '3month') {
        return 'quarterly';
    }
    return null;
}

function normalizeMapping(planRaw: unknown, intervalRaw: unknown): PriceMapping | null {
    const plan = normalizePlan(planRaw);
    const interval = normalizeInterval(intervalRaw);
    if (!plan || !interval) return null;
    if (plan === 'jobs_premium' && interval === 'quarterly') return null;
    if (plan === 'premium' && interval === 'weekly') return null;
    if (plan === 'part_time' && interval !== 'weekly') return null;
    return { plan, interval };
}

function inferFromRecurring(
    interval: string | undefined,
    intervalCount: number | undefined,
    productPlan: MappedPlan | null
): PriceMapping | null {
    const count = intervalCount ?? 1;
    if (interval === 'week' && count === 1) {
        return { plan: 'jobs_premium', interval: 'weekly' };
    }
    if (interval === 'month' && count === 1) {
        return { plan: productPlan === 'jobs_premium' ? 'jobs_premium' : 'premium', interval: 'monthly' };
    }
    if (interval === 'month' && count === 3) {
        return { plan: 'premium', interval: 'quarterly' };
    }
    return null;
}

function buildStaticRegistry(): Map<string, PriceMapping> {
    const map = new Map<string, PriceMapping>();

    const add = (priceId: string | undefined, mapping: PriceMapping) => {
        if (priceId) map.set(priceId, mapping);
    };

    add(getWeeklyPriceId(), { plan: 'jobs_premium', interval: 'weekly' });
    add(getJobsMonthlyPriceId(), { plan: 'jobs_premium', interval: 'monthly' });
    add(getPartTimeWeeklyPriceId(), { plan: 'part_time', interval: 'weekly' });
    add(getMonthlyPriceId(), { plan: 'premium', interval: 'monthly' });
    add(getQuarterlyPriceId(), { plan: 'premium', interval: 'quarterly' });

    for (const priceId of parseCommaList(process.env.STRIPE_LEGACY_PRICE_WEEKLY)) {
        add(priceId, { plan: 'jobs_premium', interval: 'weekly' });
    }
    for (const priceId of parseCommaList(process.env.STRIPE_LEGACY_PRICE_JOBS_MONTHLY)) {
        add(priceId, { plan: 'jobs_premium', interval: 'monthly' });
    }
    for (const priceId of parseCommaList(process.env.STRIPE_LEGACY_PRICE_PART_TIME_WEEKLY)) {
        add(priceId, { plan: 'part_time', interval: 'weekly' });
    }
    for (const priceId of parseCommaList(process.env.STRIPE_LEGACY_PRICE_MONTHLY)) {
        add(priceId, { plan: 'premium', interval: 'monthly' });
    }
    for (const priceId of parseCommaList(process.env.STRIPE_LEGACY_PRICE_QUARTERLY)) {
        add(priceId, { plan: 'premium', interval: 'quarterly' });
    }

    for (const [priceId, mapping] of parseRegistryJson()) {
        map.set(priceId, mapping);
    }

    return map;
}

let staticRegistry: Map<string, PriceMapping> | null = null;

function getStaticRegistry(): Map<string, PriceMapping> {
    if (!staticRegistry) {
        staticRegistry = buildStaticRegistry();
    }
    return staticRegistry;
}

/** Clear in-memory caches (tests, after env changes). */
export function clearPriceRegistryCache(): void {
    staticRegistry = null;
    stripeCache.clear();
    clearStripeProductDiscoveryCache();
}

export function resolvePriceMappingSync(priceId: string): PriceMapping | null {
    if (!priceId || COUNSELLING_IDS.has(priceId)) return null;
    return getStaticRegistry().get(priceId) ?? null;
}

export function priceIdToPlanSync(priceId: string): MappedPlan | null {
    return resolvePriceMappingSync(priceId)?.plan ?? null;
}

export function priceIdToIntervalSync(priceId: string): MappedInterval | 'unknown' {
    return resolvePriceMappingSync(priceId)?.interval ?? 'unknown';
}

function metadataMapping(
    metadata: Record<string, string> | null | undefined
): PriceMapping | null {
    if (!metadata) return null;
    const plan =
        normalizePlan(metadata.cafy_plan) ??
        normalizePlan(metadata.plan) ??
        normalizePlan(metadata.cafy_product);
    const interval =
        normalizeInterval(metadata.cafy_interval) ??
        normalizeInterval(metadata.interval) ??
        normalizeInterval(metadata.billing_interval);
    return normalizeMapping(plan, interval);
}

async function resolveFromStripe(priceId: string): Promise<PriceMapping | null> {
    if (!isStripeConfigured() || COUNSELLING_IDS.has(priceId)) {
        return null;
    }

    const cached = stripeCache.get(priceId);
    if (cached && cached.expires > Date.now()) {
        return cached.mapping;
    }

    try {
        const price = await getStripe().prices.retrieve(priceId, { expand: ['product'] });
        if (price.type !== 'recurring') {
            stripeCache.set(priceId, { mapping: null, expires: Date.now() + NEGATIVE_CACHE_MS });
            return null;
        }

        const fromPriceMeta = metadataMapping(price.metadata);
        if (fromPriceMeta) {
            stripeCache.set(priceId, { mapping: fromPriceMeta, expires: Date.now() + CACHE_MS });
            await storePriceMapping(priceId, fromPriceMeta);
            return fromPriceMeta;
        }

        const product =
            price.product && typeof price.product === 'object' && !('deleted' in price.product && price.product.deleted)
                ? (price.product as { id?: string; metadata?: Record<string, string> })
                : null;

        const fromProductMeta = metadataMapping(product?.metadata);
        if (fromProductMeta) {
            stripeCache.set(priceId, { mapping: fromProductMeta, expires: Date.now() + CACHE_MS });
            await storePriceMapping(priceId, fromProductMeta);
            return fromProductMeta;
        }

        const products = await discoverStripeProducts();
        let productPlan: MappedPlan | null = null;
        if (product?.id && products.premium.has(product.id)) {
            productPlan = 'premium';
        } else if (product?.id && products.jobs.has(product.id)) {
            productPlan = 'jobs_premium';
        }

        const inferred = inferFromRecurring(
            price.recurring?.interval,
            price.recurring?.interval_count,
            productPlan
        );
        if (inferred) {
            let mapping = inferred;
            if (productPlan === 'premium' && inferred.plan === 'jobs_premium') {
                mapping = { plan: 'premium', interval: inferred.interval };
            }
            stripeCache.set(priceId, { mapping, expires: Date.now() + CACHE_MS });
            await storePriceMapping(priceId, mapping);
            return mapping;
        }
    } catch (err) {
        const code =
            err && typeof err === 'object' && 'code' in err
                ? String((err as { code: string }).code)
                : '';
        const message = err instanceof Error ? err.message : String(err);
        if (code === 'resource_missing' && message.includes('live mode')) {
            console.warn(
                `[billing] Price ${priceId} exists in Stripe live mode but API key is test mode. ` +
                    'Use live Stripe keys in production, or seed billing_price_mappings in Firestore.'
            );
        } else {
            console.warn('[billing] resolveFromStripe failed:', priceId, err);
        }
    }

    stripeCache.set(priceId, { mapping: null, expires: Date.now() + NEGATIVE_CACHE_MS });
    return null;
}

/**
 * Resolve a Stripe Price ID to Cafy plan + billing interval.
 * Order: current env prices → Firestore cache → Stripe (product auto-discovery) → store cache.
 */
export async function resolvePriceMapping(priceId: string): Promise<PriceMapping | null> {
    const sync = resolvePriceMappingSync(priceId);
    if (sync) return sync;

    const stored = await getStoredPriceMapping(priceId);
    if (stored) {
        stripeCache.set(priceId, { mapping: stored, expires: Date.now() + CACHE_MS });
        return stored;
    }

    return resolveFromStripe(priceId);
}

export function isFullPremiumPriceIdSync(priceId: string): boolean {
    const mapping = resolvePriceMappingSync(priceId);
    return mapping?.plan === 'premium';
}

export function isWeeklyPriceIdSync(priceId: string): boolean {
    const mapping = resolvePriceMappingSync(priceId);
    return mapping?.plan === 'jobs_premium' && mapping.interval === 'weekly';
}

export function isJobsMonthlyPriceIdSync(priceId: string): boolean {
    const mapping = resolvePriceMappingSync(priceId);
    return mapping?.plan === 'jobs_premium' && mapping.interval === 'monthly';
}

export function isJobsPremiumPriceIdSync(priceId: string): boolean {
    return resolvePriceMappingSync(priceId)?.plan === 'jobs_premium';
}

export function isPartTimeWeeklyPriceIdSync(priceId: string): boolean {
    const mapping = resolvePriceMappingSync(priceId);
    return mapping?.plan === 'part_time' && mapping.interval === 'weekly';
}

export function isPartTimePremiumPriceIdSync(priceId: string): boolean {
    return resolvePriceMappingSync(priceId)?.plan === 'part_time';
}

/** Firestore subscription row is out of sync with the resolved Stripe price. */
export function subscriptionNeedsRepair(sub: {
    status?: string;
    plan?: string;
    billingInterval?: string | null;
    priceId?: string | null;
    stripeSubscriptionId?: string | null;
}): boolean {
    const status = String(sub.status ?? '');
    const plan = String(sub.plan ?? 'free');
    const billingInterval = sub.billingInterval ?? null;
    const priceId = sub.priceId ?? null;
    const stripeSubscriptionId = sub.stripeSubscriptionId ?? null;

    const activeLike =
        status === 'active' || status === 'trialing' || status === 'past_due';
    if (!activeLike || !stripeSubscriptionId || !priceId) {
        return false;
    }

    const knownPaidPrice = resolvePriceMappingSync(priceId);
    if (knownPaidPrice) {
        return (
            plan !== knownPaidPrice.plan ||
            billingInterval === 'unknown' ||
            !billingInterval ||
            billingInterval !== knownPaidPrice.interval
        );
    }

    return isUnmappedActiveSubscription({
        status,
        plan,
        billingInterval,
        priceId,
        stripeSubscriptionId,
    });
}

/** Active subscription with a price we cannot map to a paid Cafy plan. */
export function isUnmappedActiveSubscription(params: {
    status: string;
    plan: string;
    billingInterval?: string | null;
    priceId?: string | null;
    stripeSubscriptionId?: string | null;
}): boolean {
    const activeLike =
        params.status === 'active' || params.status === 'trialing' || params.status === 'past_due';
    if (!activeLike || !params.stripeSubscriptionId || !params.priceId) {
        return false;
    }
    if (params.plan === 'premium' || params.plan === 'jobs_premium' || params.plan === 'part_time') {
        return false;
    }
    if (resolvePriceMappingSync(params.priceId)) {
        return false;
    }
    return params.plan === 'free' || params.billingInterval === 'unknown' || !params.billingInterval;
}
