import type { Request } from 'express';
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import {
    createRedisStore,
    initRateLimitStore,
    shouldFailClosedOnStoreError,
} from './rateLimitStore';

/** Skip cheap / system routes to reduce Redis commands and false 429s. */
export function shouldSkipCommonRateLimit(req: Request): boolean {
    if (req.method === 'OPTIONS') {
        return true;
    }
    const path = req.path;
    if (path === '/api/health' || path === '/' || path === '/api/internal/warm-sponsorship' || path === '/api/internal/jobs-catalog-synced' || path === '/api/internal/email-outbox' || path === '/api/internal/email-campaigns') {
        return true;
    }
    if (path === '/api/mentors' || path === '/api/auth/session-login' || path === '/api/counselling/webhook') {
        return true;
    }
    return false;
}

function clientIpKey(req: Request): string {
    const ip = req.ip ?? 'unknown';
    return ipKeyGenerator(ip);
}

/** After verifyToken — prefer Firebase uid; fall back to IP. */
export function authenticatedUserKey(req: Request): string {
    const uid = (req as Request & { user?: { uid?: string } }).user?.uid;
    if (typeof uid === 'string' && uid.length > 0) {
        return `uid:${uid}`;
    }
    return `ip:${clientIpKey(req)}`;
}

type LimiterOptions = {
    windowMs: number;
    max: number;
    message: string;
    prefix: string;
    keyGenerator?: (req: Request) => string;
    skip?: (req: Request) => boolean;
    /** Reject requests when the Redis store errors, regardless of RATE_LIMIT_REDIS_REQUIRED. */
    failClosed?: boolean;
};

function buildLimiter(options: LimiterOptions): RateLimitRequestHandler {
    const store = createRedisStore(options.prefix);
    const failClosed = options.failClosed === true || shouldFailClosedOnStoreError();

    return rateLimit({
        windowMs: options.windowMs,
        max: options.max,
        standardHeaders: true,
        legacyHeaders: false,
        message: options.message,
        store,
        keyGenerator: options.keyGenerator ?? clientIpKey,
        skip: options.skip,
        // Fail-open by default so Redis blips do not take down the API (set RATE_LIMIT_REDIS_REQUIRED=true to fail closed).
        passOnStoreError: !failClosed,
    });
}

initRateLimitStore();

function isAiRateLimitPath(path: string): boolean {
    return path === '/api/ai/generate';
}

/** Authenticated product reads — per user, not counted against the global IP bucket. */
function isAuthenticatedProductRead(req: Request): boolean {
    const path = req.path;
    return (
        path.startsWith('/api/jobs-portal') ||
        path === '/api/usage-status' ||
        path.startsWith('/api/communications') ||
        path.startsWith('/api/resources')
    );
}

export const globalLimiter = buildLimiter({
    windowMs: 15 * 60 * 1000,
    max: process.env.NODE_ENV === 'production'
        ? parseInt(process.env.GLOBAL_RATE_LIMIT_MAX || '400', 10)
        : 10_000,
    message: 'Too many requests from this IP, please try again later.',
    prefix: 'rl:global:',
    skip: (req) =>
        shouldSkipCommonRateLimit(req) ||
        req.path.startsWith('/api/billing') ||
        isAiRateLimitPath(req.path) ||
        isAuthenticatedProductRead(req),
});

export const billingLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 120 : 2000,
    message: 'Too many billing requests. Please wait a moment and try again.',
    prefix: 'rl:billing:',
    skip: (req) =>
        shouldSkipCommonRateLimit(req) || process.env.BILLING_RATE_LIMIT_OFF === 'true',
});

export const aiLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many AI requests. Please wait a minute.',
    prefix: 'rl:ai:',
    keyGenerator: authenticatedUserKey,
});

export const securityLogLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 30 : 120,
    message: 'Too many security log requests. Please slow down.',
    prefix: 'rl:sec:',
    keyGenerator: authenticatedUserKey,
});

/** Jobs feed browse/search — per authenticated user. */
export const jobsFeedLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 120 : 2000,
    message: 'Too many jobs feed requests. Please wait a moment and try again.',
    prefix: 'rl:jobs-feed:',
    keyGenerator: authenticatedUserKey,
});

/** Sponsor register search + pagination — per authenticated user. */
export const sponsorshipDataLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 90 : 2000,
    message: 'Too many sponsor register requests. Please wait a moment and try again.',
    prefix: 'rl:sponsorship:',
    keyGenerator: authenticatedUserKey,
});

/** Per-user limit on reserve / confirm to prevent slot spam. */
export const counsellingBookingLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 20 : 200,
    message: 'Too many booking attempts. Please wait a moment and try again.',
    prefix: 'rl:counselling:',
    keyGenerator: authenticatedUserKey,
});

/** Per-user limit on resource download tracking + authenticated file fetches. */
export const resourcesDownloadLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 40 : 400,
    message: 'Too many download requests. Please wait a moment and try again.',
    prefix: 'rl:resources-download:',
    keyGenerator: authenticatedUserKey,
});

/** Companies House proxy — each company modal triggers up to two upstream calls. */
export const companiesHouseSearchLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 30 : 500,
    message: 'Too many organisation lookups. Please wait a minute before opening more company details.',
    prefix: 'rl:companies-house:',
    keyGenerator: authenticatedUserKey,
});

/** Public unsubscribe + cancel-feedback from marketing site / email clients. */
export const emailPublicLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 30 : 200,
    message: 'Too many email preference requests. Please wait a moment and try again.',
    prefix: 'rl:email-public:',
});

/**
 * Public job preview — unauthenticated, IP-only, fail-closed (a Redis outage must
 * never turn the anonymous endpoint into an unlimited scraping target).
 */
export const publicPreviewMinuteLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 10 : 500,
    message: 'Too many requests. Please wait a moment and try again.',
    prefix: 'rl:public-preview:',
    failClosed: true,
});

export const publicPreviewDailyLimiter = buildLimiter({
    windowMs: 24 * 60 * 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 40 : 5000,
    message: 'Daily preview limit reached. Sign up free to keep browsing jobs.',
    prefix: 'rl:public-preview-day:',
    failClosed: true,
});

/** Sponsorship hub favourites sync — per authenticated user. */
export const sponsorshipFavoritesLimiter = buildLimiter({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 60 : 2000,
    message: 'Too many favourites updates. Please wait a moment and try again.',
    prefix: 'rl:sponsorship-fav:',
    keyGenerator: authenticatedUserKey,
});

/** Account deletion — very low per-user ceiling. */
export const accountDeleteLimiter = buildLimiter({
    windowMs: 60 * 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 5 : 50,
    message: 'Too many account deletion attempts. Please wait and try again later.',
    prefix: 'rl:account-delete:',
    keyGenerator: authenticatedUserKey,
});

/** Post-signup email tombstone check — IP-based; must not share the delete bucket. */
export const accountAssertSignupLimiter = buildLimiter({
    windowMs: 15 * 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 40 : 200,
    message: 'Too many signup checks. Please wait a few minutes and try again.',
    prefix: 'rl:account-assert:',
});
