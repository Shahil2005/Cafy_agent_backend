import {
    getJobsMonthlyPriceId,
    getMonthlyPriceId,
    getPartTimeWeeklyPriceId,
    getQuarterlyPriceId,
    getWeeklyPriceId,
} from './config';
import { getStripe, isStripeConfigured } from './stripeClient';

export interface ResolvedPlanPrice {
    priceId: string;
    priceDisplay: string;
    pricePeriod: string;
    /** Amount in pence for upgrade preview calculations */
    unitAmountMinor: number | null;
    /** Days between renewal dates (from Stripe invoice preview or subscription period). */
    billingPeriodDays: number | null;
    /** Formatted per-day amount, e.g. "£0.81/day". */
    pricePerDayDisplay: string | null;
    /** ISO timestamps for the previewed first billing period (new subscription starting now). */
    renewalPeriodStart: string | null;
    renewalPeriodEnd: string | null;
}

const SECONDS_PER_DAY = 86_400;

const CACHE_MS = 5 * 60 * 1000;
let cached: {
    expires: number;
    monthly: CachedPriceAmount | null;
    quarterly: CachedPriceAmount | null;
    weekly: CachedPriceAmount | null;
    jobsMonthly: CachedPriceAmount | null;
    partTimeWeekly: CachedPriceAmount | null;
} | null = null;

interface CachedPriceAmount {
    priceId: string;
    priceDisplay: string;
    pricePeriod: string;
    unitAmountMinor: number | null;
    currency: string;
}

function formatMoneyMinor(amountMinor: number, currency: string): string {
    return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: currency.toUpperCase(),
        minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
    }).format(amountMinor / 100);
}

/** Days between Stripe renewal timestamps (matches subscription period length). */
export function billingPeriodDaysFromStripeTimestamps(
    periodStartSeconds: number,
    periodEndSeconds: number
): number {
    return Math.max(0, Math.floor((periodEndSeconds - periodStartSeconds) / SECONDS_PER_DAY));
}

function recurringPeriod(interval: string | undefined, intervalCount: number | undefined): string {
    const count = intervalCount ?? 1;
    const unit = interval ?? 'month';
    if (unit === 'week' && count === 1) return '/week';
    if (unit === 'month' && count === 1) return '/month';
    if (unit === 'month' && count === 3) return '/3 months';
    if (unit === 'year' && count === 1) return '/year';
    return `/${count} ${unit}${count > 1 ? 's' : ''}`;
}

function formatPricePerDay(unitAmountMinor: number, periodDays: number, currency: string): string {
    const perDayMinor = Math.round(unitAmountMinor / periodDays);
    return `${formatMoneyMinor(perDayMinor, currency)}/day`;
}

/** Per-day price from Stripe period timestamps only (handles variable month/quarter lengths). */
export function pricePerDayFromRenewalTimestamps(
    unitAmountMinor: number,
    periodStartSeconds: number,
    periodEndSeconds: number,
    currency: string
): { billingPeriodDays: number; pricePerDayDisplay: string } | null {
    if (periodEndSeconds <= periodStartSeconds) {
        return null;
    }
    const billingPeriodDays = billingPeriodDaysFromStripeTimestamps(
        periodStartSeconds,
        periodEndSeconds
    );
    if (billingPeriodDays <= 0) {
        return null;
    }
    return {
        billingPeriodDays,
        pricePerDayDisplay: formatPricePerDay(unitAmountMinor, billingPeriodDays, currency),
    };
}

/**
 * Stripe's exact renewal window for a new subscription on this price (e.g. 28 Feb → 28 Mar).
 * Uses invoice preview line-item period (top-level period_start/end are the invoice date only).
 */
async function stripeRenewalPeriod(priceId: string): Promise<{
    billingPeriodDays: number;
    periodStartSeconds: number;
    periodEndSeconds: number;
    renewalPeriodStart: string;
    renewalPeriodEnd: string;
} | null> {
    try {
        const preview = await getStripe().invoices.createPreview({
            subscription_details: {
                items: [{ price: priceId }],
            },
        });

        const linePeriod = preview.lines?.data?.[0]?.period;
        const start = linePeriod?.start ?? preview.period_start;
        const end = linePeriod?.end ?? preview.period_end;
        if (start == null || end == null || end <= start) {
            return null;
        }

        const billingPeriodDays = billingPeriodDaysFromStripeTimestamps(start, end);
        if (billingPeriodDays <= 0) {
            return null;
        }
        return {
            billingPeriodDays,
            periodStartSeconds: start,
            periodEndSeconds: end,
            renewalPeriodStart: new Date(start * 1000).toISOString(),
            renewalPeriodEnd: new Date(end * 1000).toISOString(),
        };
    } catch (err) {
        console.error('[billing] stripeRenewalPeriod failed:', priceId, err);
        return null;
    }
}

async function enrichWithRenewalPeriod(cached: CachedPriceAmount): Promise<ResolvedPlanPrice> {
    const renewal = await stripeRenewalPeriod(cached.priceId);
    const perDay =
        cached.unitAmountMinor != null && renewal
            ? pricePerDayFromRenewalTimestamps(
                  cached.unitAmountMinor,
                  renewal.periodStartSeconds,
                  renewal.periodEndSeconds,
                  cached.currency
              )
            : null;

    return {
        priceId: cached.priceId,
        priceDisplay: cached.priceDisplay,
        pricePeriod: cached.pricePeriod,
        unitAmountMinor: cached.unitAmountMinor,
        billingPeriodDays: perDay?.billingPeriodDays ?? renewal?.billingPeriodDays ?? null,
        pricePerDayDisplay: perDay?.pricePerDayDisplay ?? null,
        renewalPeriodStart: renewal?.renewalPeriodStart ?? null,
        renewalPeriodEnd: renewal?.renewalPeriodEnd ?? null,
    };
}

async function resolvePriceAmounts(priceId: string): Promise<CachedPriceAmount> {
    const price = await getStripe().prices.retrieve(priceId);
    const period = recurringPeriod(price.recurring?.interval, price.recurring?.interval_count);
    if (price.unit_amount == null) {
        return {
            priceId,
            priceDisplay: '—',
            pricePeriod: period,
            unitAmountMinor: null,
            currency: price.currency,
        };
    }
    return {
        priceId,
        priceDisplay: formatMoneyMinor(price.unit_amount, price.currency),
        pricePeriod: period,
        unitAmountMinor: price.unit_amount,
        currency: price.currency,
    };
}

function fallbackPrice(priceId: string, period: string): ResolvedPlanPrice {
    return {
        priceId,
        priceDisplay: '—',
        pricePeriod: period,
        unitAmountMinor: null,
        billingPeriodDays: null,
        pricePerDayDisplay: null,
        renewalPeriodStart: null,
        renewalPeriodEnd: null,
    };
}

/**
 * Live GBP amounts from Stripe Price objects (amounts cached 5 min).
 * Per-day pricing uses a fresh Stripe invoice preview each call for exact renewal spacing.
 */
export async function getStripePlanPrices(): Promise<{
    monthly: ResolvedPlanPrice | null;
    quarterly: ResolvedPlanPrice | null;
    weekly: ResolvedPlanPrice | null;
    jobsMonthly: ResolvedPlanPrice | null;
    partTimeWeekly: ResolvedPlanPrice | null;
}> {
    const now = Date.now();
    if (!cached || cached.expires <= now) {
        const monthlyId = getMonthlyPriceId();
        const quarterlyId = getQuarterlyPriceId();
        const weeklyId = getWeeklyPriceId();
        const jobsMonthlyId = getJobsMonthlyPriceId();
        const partTimeWeeklyId = getPartTimeWeeklyPriceId();

        if (!isStripeConfigured()) {
            return {
                monthly: monthlyId ? fallbackPrice(monthlyId, '/month') : null,
                quarterly: quarterlyId ? fallbackPrice(quarterlyId, '/3 months') : null,
                weekly: weeklyId ? fallbackPrice(weeklyId, '/week') : null,
                jobsMonthly: jobsMonthlyId ? fallbackPrice(jobsMonthlyId, '/month') : null,
                partTimeWeekly: partTimeWeeklyId ? fallbackPrice(partTimeWeeklyId, '/week') : null,
            };
        }

        const [monthly, quarterly, weekly, jobsMonthly, partTimeWeekly] = await Promise.all([
            monthlyId
                ? resolvePriceAmounts(monthlyId).catch(() => ({
                      priceId: monthlyId,
                      priceDisplay: '—',
                      pricePeriod: '/month',
                      unitAmountMinor: null,
                      currency: 'gbp',
                  }))
                : null,
            quarterlyId
                ? resolvePriceAmounts(quarterlyId).catch(() => ({
                      priceId: quarterlyId,
                      priceDisplay: '—',
                      pricePeriod: '/3 months',
                      unitAmountMinor: null,
                      currency: 'gbp',
                  }))
                : null,
            weeklyId
                ? resolvePriceAmounts(weeklyId).catch(() => ({
                      priceId: weeklyId,
                      priceDisplay: '—',
                      pricePeriod: '/week',
                      unitAmountMinor: null,
                      currency: 'gbp',
                  }))
                : null,
            jobsMonthlyId
                ? resolvePriceAmounts(jobsMonthlyId).catch(() => ({
                      priceId: jobsMonthlyId,
                      priceDisplay: '—',
                      pricePeriod: '/month',
                      unitAmountMinor: null,
                      currency: 'gbp',
                  }))
                : null,
            partTimeWeeklyId
                ? resolvePriceAmounts(partTimeWeeklyId).catch(() => ({
                      priceId: partTimeWeeklyId,
                      priceDisplay: '—',
                      pricePeriod: '/week',
                      unitAmountMinor: null,
                      currency: 'gbp',
                  }))
                : null,
        ]);

        cached = {
            expires: now + CACHE_MS,
            monthly,
            quarterly,
            weekly,
            jobsMonthly,
            partTimeWeekly,
        };
    }

    const [monthly, quarterly, weekly, jobsMonthly, partTimeWeekly] = await Promise.all([
        cached.monthly ? enrichWithRenewalPeriod(cached.monthly) : null,
        cached.quarterly ? enrichWithRenewalPeriod(cached.quarterly) : null,
        cached.weekly ? enrichWithRenewalPeriod(cached.weekly) : null,
        cached.jobsMonthly ? enrichWithRenewalPeriod(cached.jobsMonthly) : null,
        cached.partTimeWeekly ? enrichWithRenewalPeriod(cached.partTimeWeekly) : null,
    ]);

    return { monthly, quarterly, weekly, jobsMonthly, partTimeWeekly };
}

const priceIdDisplayCache = new Map<
    string,
    { expires: number; priceDisplay: string; pricePeriod: string }
>();

/** Lookup a Stripe Price by ID (legacy or current) for subscriber-facing labels. */
export async function resolvePriceDisplayByPriceId(
    priceId: string
): Promise<{ priceDisplay: string; pricePeriod: string } | null> {
    if (!isStripeConfigured() || !priceId?.trim()) {
        return null;
    }

    const cachedEntry = priceIdDisplayCache.get(priceId);
    if (cachedEntry && cachedEntry.expires > Date.now()) {
        return {
            priceDisplay: cachedEntry.priceDisplay,
            pricePeriod: cachedEntry.pricePeriod,
        };
    }

    try {
        const resolved = await resolvePriceAmounts(priceId);
        if (resolved.priceDisplay === '—') {
            return null;
        }
        priceIdDisplayCache.set(priceId, {
            expires: Date.now() + CACHE_MS,
            priceDisplay: resolved.priceDisplay,
            pricePeriod: resolved.pricePeriod,
        });
        return {
            priceDisplay: resolved.priceDisplay,
            pricePeriod: resolved.pricePeriod,
        };
    } catch (err) {
        console.warn('[billing] resolvePriceDisplayByPriceId failed:', priceId, err);
        return null;
    }
}

/** Test helper — clear in-memory cache after env/price changes. */
export function clearPlanPricingCache(): void {
    cached = null;
    priceIdDisplayCache.clear();
}
