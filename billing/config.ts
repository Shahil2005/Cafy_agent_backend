export function isBillingEnabled(): boolean {
    return process.env.BILLING_ENABLED === 'true';
}

export function isJobsWeeklyEnabled(): boolean {
    return process.env.JOBS_WEEKLY_ENABLED === 'true';
}

/** Part-time jobs weekly plan — enabled when a Stripe price is configured. */
export function isPartTimeWeeklyEnabled(): boolean {
    return Boolean(getPartTimeWeeklyPriceId());
}

export function getFreeCommLimit(): number {
    const n = parseInt(process.env.FREE_COMM_GENERATION_LIMIT || '5', 10);
    return Number.isFinite(n) && n >= 0 ? n : 5;
}

export function getFreeExtCoverLetterLimit(): number {
    const n = parseInt(process.env.FREE_EXT_COVER_LETTER_LIMIT || '5', 10);
    return Number.isFinite(n) && n >= 0 ? n : 5;
}

export function getFreeExtensionAnalysisLimit(): number {
    const n = parseInt(process.env.FREE_LIFETIME_ANALYSIS_LIMIT || '5', 10);
    return Number.isFinite(n) && n >= 0 ? n : 5;
}

/** Lifetime cap on extension autofill runs for users without Full Premium. */
export function getFreeAutofillLifetimeLimit(): number {
    const n = parseInt(process.env.FREE_AUTOFILL_LIFETIME_LIMIT || '5', 10);
    return Number.isFinite(n) && n >= 0 ? n : 5;
}

/** Extension autofill runs per day (UK time) for Full Premium. */
export function getPremiumAutofillDailyLimit(): number {
    const n = parseInt(process.env.PREMIUM_AUTOFILL_DAILY_LIMIT || '20', 10);
    return Number.isFinite(n) && n >= 0 ? n : 20;
}

/** Lifetime cap for free + Jobs Premium users on the Career Path analysis feature. */
export function getFreeCareerAnalysisLifetimeLimit(): number {
    const n = parseInt(process.env.FREE_CAREER_ANALYSIS_LIFETIME_LIMIT || '1', 10);
    return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** Daily cap for Full Premium (monthly + quarterly) users on the Career Path analysis feature. */
export function getPremiumCareerAnalysisDailyLimit(): number {
    const n = parseInt(process.env.PREMIUM_CAREER_ANALYSIS_DAILY_LIMIT || '1', 10);
    return Number.isFinite(n) && n >= 0 ? n : 1;
}

export function getMonthlyPriceId(): string | undefined {
    return process.env.STRIPE_PRICE_MONTHLY || undefined;
}

export function getQuarterlyPriceId(): string | undefined {
    return process.env.STRIPE_PRICE_QUARTERLY || undefined;
}

export function getWeeklyPriceId(): string | undefined {
    return process.env.STRIPE_PRICE_WEEKLY || undefined;
}

/** Jobs Premium billed monthly (same entitlements as weekly). */
export function getJobsMonthlyPriceId(): string | undefined {
    return process.env.STRIPE_PRICE_JOBS_MONTHLY || undefined;
}

/** Part-time jobs only, billed weekly. */
export function getPartTimeWeeklyPriceId(): string | undefined {
    const id = process.env.STRIPE_PRICE_PART_TIME_WEEKLY?.trim();
    return id || undefined;
}

/** Full Premium checkout / upgrade targets (monthly + quarterly). */
export function getFullPremiumPriceIds(): string[] {
    return [getMonthlyPriceId(), getQuarterlyPriceId()].filter((id): id is string => !!id);
}

/** Jobs-only checkout prices (weekly + monthly). */
export function getJobsPremiumPriceIds(): string[] {
    if (!isJobsWeeklyEnabled()) return [];
    return [getWeeklyPriceId(), getJobsMonthlyPriceId()].filter((id): id is string => !!id);
}

/** Part-time-only checkout prices. */
export function getPartTimePremiumPriceIds(): string[] {
    if (!isPartTimeWeeklyEnabled()) return [];
    return [getPartTimeWeeklyPriceId()].filter((id): id is string => !!id);
}

/** All price IDs allowed for new Stripe Checkout sessions. */
export function getAllowedPriceIds(): string[] {
    return [
        ...getFullPremiumPriceIds(),
        ...getJobsPremiumPriceIds(),
        ...getPartTimePremiumPriceIds(),
    ];
}

/**
 * Comma-separated browser origins (CORS + Stripe return URLs).
 * Order: Cafy Product first, Resume studio second — e.g.
 * FRONTEND_URL=https://app.cafy.careers,http://localhost:3000
 */
export function parseFrontendUrls(): string[] {
    return (process.env.FRONTEND_URL || '')
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean);
}

/** Cafy Product (first origin). */
export function getFrontendUrl(): string {
    return parseFrontendUrls()[0] || 'https://app.cafy.careers';
}

/** Resume studio (second origin when listed, else match :3000). */
export function getResumeToolFrontendUrl(): string {
    const legacy = process.env.RESUME_TOOL_FRONTEND_URL?.split(',')[0]?.trim();
    if (legacy) {
        return legacy;
    }
    const urls = parseFrontendUrls();
    if (urls.length >= 2) {
        return urls[1];
    }
    const resumeOrigin = urls.find((u) => /:3000(\/|$)/.test(u));
    return resumeOrigin || urls[0] || 'http://localhost:3000';
}

export {
    priceIdToIntervalSync as priceIdToInterval,
    priceIdToPlanSync as priceIdToPlan,
    isWeeklyPriceIdSync as isWeeklyPriceId,
    isJobsMonthlyPriceIdSync as isJobsMonthlyPriceId,
    isJobsPremiumPriceIdSync as isJobsPremiumPriceId,
    isFullPremiumPriceIdSync as isFullPremiumPriceId,
    isPartTimeWeeklyPriceIdSync as isPartTimeWeeklyPriceId,
    resolvePriceMapping,
    resolvePriceMappingSync,
} from './priceRegistry';
