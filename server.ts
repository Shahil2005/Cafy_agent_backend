import dns from 'dns';
// Programmatically prioritize IPv4 to prevent local ISP IPv6 routing timeouts (e.g., Jio/Airtel/corporate firewalls)
dns.setDefaultResultOrder('ipv4first');
process.env.GRPC_DNS_RESOLVER = 'native';

import './instrument';

import * as Sentry from '@sentry/node';
import express, { Request, Response } from 'express';
import cors from 'cors';
import * as admin from 'firebase-admin';
import helmet from 'helmet';
import hpp from 'hpp';
import {
    globalLimiter,
    billingLimiter,
    aiLimiter,
    securityLogLimiter,
    publicPreviewMinuteLimiter,
    publicPreviewDailyLimiter,
    resourcesDownloadLimiter,
    emailPublicLimiter,
    accountDeleteLimiter,
    accountAssertSignupLimiter,
} from './middleware/rateLimiters';
import mongoSanitize from 'express-mongo-sanitize';
import cookieParser from 'cookie-parser';
import { z } from 'zod';
import { verifyTurnstileToken, isTurnstileVerified } from './turnstileService';
import { checkBetaAccess } from './utils/betaAccess';
import { getUserUsageStatus, checkAndIncrementUsage } from './usageService';
import { addJob } from './jobsService';
import jobsPortalRouter from './jobs-portal/router';
import { conversationHandlers, handleAgentTurn } from './agent/handler';
import { handleAgentFeedback } from './agent/feedback';
import { handleAgentCvCleanup } from './agent/cleanup';
import { cvTailorHandlers } from './agent/tailorHandler';
import { warmSponsorshipCache, invalidateJobsCatalogCaches } from './jobs-portal/service';
import { isValidPublicPartTimeQuery, parsePublicPreviewQuery } from './jobs-portal/publicPreview/schema';
import { getPublicPartTimePreview, getPublicPreview } from './jobs-portal/publicPreview/service';
import { requireTurnstileToken } from './jobs-portal/publicPreview/turnstileGuard';
import { warmIrelandSponsorshipCache } from './jobs-portal/irelandSponsorship';
import { syncDirectoryEmployers } from './jobs-portal/directoryEmployersSync';
import * as storageService from './storageService';
import { createBillingRouter, stripeWebhookHandler } from './billing/router';
import { createAccountRouter } from './account/router';
import { handleAnalyticsEvent } from './analytics/router';
import {
    handleSecureGenerate,
    handleExtensionCoverLetter,
    handleExtensionLinkedinOptimizer,
    handleExtensionLinkedinScan,
    handleExtensionGetLinkedinProfile,
} from './ai/handlers';
import { handleCareerAnalysis } from './ai/careerAnalysis/handler';
import {
    handleExtensionAutofillProfile,
    handleExtensionAutofillProfileUpdate,
    handleExtensionAutofillFill,
} from './ai/autofill/handler';
import { extractPdfLinks, extractPdfText, isPdfUnreadableError } from './ai/careerAnalysis/parser';
import { createCommunicationsRouter } from './communications/router';
import { createEmailRouter } from './email/router';
import {
    checkRateLimitRedisHealth,
    getRateLimitBackend,
    isRateLimitRedisRequired,
} from './middleware/rateLimitStore';
import { fetchActiveMentors } from './lib/mentorService';
import { createCounsellingRouter } from './counselling/router';
import { createCalComWebhookHandler } from './counselling/calcomWebhookHandler';
import { startCounsellingMaintenanceCron } from './counselling/cron';
import { getCounsellingPublicStatus } from './counselling/service';
import { createResumeSupabaseClient } from './lib/mentorStorage';
import { setSentryUser } from './lib/observability/sentry';
import { createResourcesRouter } from './resources/router';


// 0. Global Process Protections (Prevent Server Crash)
process.on('uncaughtException', (err) => {
    if (process.env.NODE_ENV === 'production') {
        Sentry.captureException(err);
    }
    console.error(`FATAL: Uncaught Exception: ${err.message}`, err.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    if (process.env.NODE_ENV === 'production') {
        Sentry.captureException(reason);
    }
    console.error(`FATAL: Unhandled Rejection at: ${promise} reason: ${reason}`);
    process.exit(1);
});

const app = express();
const PORT = process.env.PORT || 5000;

// Resume Supabase — mentors DB, bookings, and mentor-photos storage bucket
const resumeSupabase = createResumeSupabaseClient();

// 0.1 Trust Proxy (Required for Rate Limiting behind Vercel/Cloudflare)
app.set('trust proxy', 1);

// 1. CORS Policy
const envOrigins = process.env.FRONTEND_URL 
    ? process.env.FRONTEND_URL.split(',').map(url => url.trim()) 
    : [];

const extensionOrigin = process.env.CHROME_EXTENSION_ORIGIN?.trim() || null;
/** Production browser origins (also set FRONTEND_URL on Vercel for Stripe return URLs). */
const productionOrigins = [
    'https://app.cafy.careers',
    'https://app.cafy.careers',
    'https://resume.cafy.careers',
    'https://cafy.careers',
    'https://www.cafy.careers',
];

// Explicit local browser origins for the existing apps and Vite previews.
// Production keeps its configured/site origins; no localhost wildcard is introduced.
const developmentOrigins = process.env.NODE_ENV === 'production' ? [] : [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'http://localhost:5175',
    'http://127.0.0.1:5175',
    'http://localhost:5199',
    'http://127.0.0.1:5199',
];

const allowedOrigins = [
    ...new Set([
        ...developmentOrigins,
        'http://localhost:3000',
        'https://app.cafy.careers',
        'https://app.cafy.careers',
        // Website dev server (Vite's default port), also when opened as 127.0.0.1
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:5174',
        'http://localhost:5199',
        ...productionOrigins,
        ...envOrigins,
        ...(extensionOrigin ? [extensionOrigin] : []),
    ]),
].filter(Boolean) as string[];

function isAllowedOrigin(origin: string | undefined): boolean {
    return !origin || allowedOrigins.includes(origin) || origin.startsWith('chrome-extension://');
}

// Disable ETags — otherwise 304 responses can reuse a cached Access-Control-Allow-Origin
// from a different frontend (app vs resume) and break CORS in the browser.
app.set('etag', false);

app.use(cors({
    origin: function (origin, callback) {
        if (isAllowedOrigin(origin)) {
            // Echo the request origin explicitly (never a stale value from another site).
            callback(null, origin ?? true);
        } else {
            // The browser only reports "CORS error": say here which origin was refused
            console.warn('[cors] Origin rejected - add it to FRONTEND_URL if it is a Cafy frontend', {
                requestOrigin: origin,
                configuredOrigin: extensionOrigin ?? '(not set)',
            });
            const corsErr = new Error('Not allowed by CORS API Policy') as any;
            corsErr.status = 403;
            callback(corsErr);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Turnstile-Token'],
}));

// API responses must not be cached cross-origin (Vary: Origin alone is not enough for 304).
app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    next();
});

// 2. Security Headers (Helmet) - Configured for cross-origin
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: { policy: "unsafe-none" },
}));

// Keep the API host out of search results (SEO Action Guide D1): every response is noindex
// and robots.txt disallows crawling. The API serves JSON only; www.cafy.careers is the site.
app.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
});
app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

// 3. Rate Limiting (Upstash Redis when configured — see middleware/rateLimitStore.ts)
app.use(globalLimiter);

const SECURITY_EVENT_TYPES = [
    'auth_login_success',
    'auth_login_failure',
    'auth_signup_success',
    'auth_signup_failure',
    'auth_logout',
    'session_conflict',
    'session_force_switch',
    'session_revoked',
    'api_error',
    'validation_failure',
    'suspicious_activity',
] as const;

const SECURITY_SEVERITY = ['info', 'warning', 'error', 'critical'] as const;

const MAX_METADATA_JSON_BYTES = 2_000;

const securityLogSchema = z.object({
    type: z.enum(SECURITY_EVENT_TYPES),
    severity: z.enum(SECURITY_SEVERITY),
    message: z.string().trim().min(1).max(500),
    metadata: z.record(z.string(), z.unknown()).optional(),
    deviceId: z.string().trim().max(128).optional(),
    userAgent: z.string().trim().max(300).optional(),
});

const PROTO_POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!metadata) return undefined;
    const entries = Object.entries(metadata).slice(0, 20);
    const safe: Record<string, unknown> = {};
    for (const [key, value] of entries) {
        if (!key || key.length > 64 || PROTO_POLLUTING_KEYS.has(key)) continue;
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
            safe[key] = value;
            continue;
        }
        if (Array.isArray(value)) {
            safe[key] = value.slice(0, 10).map((item) =>
                item === null || ['string', 'number', 'boolean'].includes(typeof item)
                    ? item
                    : String(item).slice(0, 200)
            );
            continue;
        }
        if (typeof value === 'object') {
            safe[key] = JSON.stringify(value).slice(0, 500);
        }
    }
    return safe;
}

function metadataWithinSizeLimit(metadata: Record<string, unknown> | undefined): boolean {
    if (!metadata) return true;
    return Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= MAX_METADATA_JSON_BYTES;
}

// 4. Data Security (Sanitization & Parameter Protection)
app.use(hpp()); // Prevent HTTP Parameter Pollution
app.use(mongoSanitize()); // Prevent NoSQL Injection (removes keys starting with $)
app.use(cookieParser()); // Parse Cookie header so req.cookies is available

// Stripe webhook must receive raw body (before JSON parser)
app.post(
    '/api/billing/webhook',
    express.raw({ type: 'application/json' }),
    stripeWebhookHandler
);

// Cal.com webhooks — raw body for HMAC verification (local: ngrok → this route)
app.post(
    '/api/counselling/webhook',
    express.raw({
        type: (req) => {
            const ct = req.headers['content-type'] ?? '';
            return (
                ct.includes('application/json') ||
                ct.includes('application/x-www-form-urlencoded') ||
                ct === ''
            );
        },
    }),
    createCalComWebhookHandler(resumeSupabase)
);

// 5. Selective Payload Limits
// Higher limit ONLY for routes that accept large text / document payloads
app.post('/api/ai/generate', express.json({ limit: '10mb' }));
app.post('/api/extension/cover-letter', express.json({ limit: '10mb' }));
// Career analysis: no Zod char cap on resumeText by design; this is the real ceiling,
// sized generously above what a 2MB PDF/DOCX upload could ever realistically extract to.
app.post('/api/ai/career-analysis', express.json({ limit: '2mb' }));
app.post('/api/jobs-portal/chat', express.json({ limit: '64kb' }));
// CV text or an encrypted continuation; parsed before the small global JSON limit.
app.post('/api/jobs-portal/career-matches', express.json({ limit: '256kb' }));
// CAFY chat agent: one message, plus the full text of a newly chosen profile CV (up to 120k chars).
app.post('/api/agent/turn', express.json({ limit: '512kb' }));
// CV tailoring: the CV text (up to 120k chars), a job description (up to 12k) and the answers.
app.post('/api/agent/cv-tailor/questions', express.json({ limit: '512kb' }));
app.post('/api/agent/cv-tailor/build', express.json({ limit: '512kb' }));
app.post('/api/extension/linkedin-optimizer', express.json({ limit: '10mb' }));
app.post('/api/extension/linkedin-scan', express.json({ limit: '10mb' }));
// Autofill: resume text (≤60k chars) plus up to 300 scraped form fields with their options.
app.post('/api/extension/autofill/profile', express.json({ limit: '1mb' }));
app.put('/api/extension/autofill/profile', express.json({ limit: '1mb' }));
app.post('/api/extension/autofill/fill', express.json({ limit: '5mb' }));
app.post('/api/storage/upload', express.raw({ type: '*/*', limit: '2mb' }));

// Initialize Firebase Admin (never log service account fields or env JSON)
if (!admin.apps.length) {
    try {
        const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;

        if (serviceAccountRaw) {
            try {
                const serviceAccount = JSON.parse(serviceAccountRaw) as {
                    client_email?: string;
                    private_key?: string;
                };
                if (!serviceAccount.client_email || !serviceAccount.private_key) {
                    throw new Error('Invalid service account shape');
                }
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
                });
                if (process.env.NODE_ENV !== 'production') {
                    console.log('Firebase Admin initialized');
                }
            } catch {
                console.error(
                    'Firebase Admin init failed: FIREBASE_SERVICE_ACCOUNT is missing required fields or invalid JSON'
                );
            }
        } else {
            admin.initializeApp();
            if (process.env.NODE_ENV !== 'production') {
                console.warn('Firebase Admin: default credentials (FIREBASE_SERVICE_ACCOUNT not set)');
            }
        }
    } catch {
        console.error('Firebase Admin initialization failed');
    }
}

// Auth Middleware
const verifyToken = async (req: Request, res: Response, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing token' });
    }

    const token = authHeader.split('Bearer ')[1];

    // Path 1: Product Site — fresh idToken sent directly from Firebase SDK
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        (req as any).user = decoded;
        setSentryUser({ id: decoded.uid });
        return next();
    } catch {}

    // Path 2: Extension — session cookie value sent as Bearer token
    try {
        const decoded = await admin.auth().verifySessionCookie(token, false);
        (req as any).user = decoded;
        setSentryUser({ id: decoded.uid });
        return next();
    } catch {}

    // Path 3: Cookie-based fallback (defense-in-depth, now works with cookie-parser)
    const cookieToken = req.cookies?.ext_auth;
    if (cookieToken) {
        try {
            const decoded = await admin.auth().verifySessionCookie(cookieToken, false);
            (req as any).user = decoded;
            setSentryUser({ id: decoded.uid });
            return next();
        } catch {}
    }

    console.error('[verifyToken] All auth paths failed for request:', req.method, req.path);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
};

// Security Logging Route
app.post('/api/security/log', express.json({ limit: '10kb' }), verifyToken, securityLogLimiter, async (req: Request, res: Response) => {
    try {
        const parsed = securityLogSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: 'Invalid security log payload',
                details: parsed.error.flatten(),
            });
        }

        const { type, severity, message, metadata, deviceId, userAgent } = parsed.data;
        const safeMetadata = sanitizeMetadata(metadata);
        if (!metadataWithinSizeLimit(safeMetadata)) {
            return res.status(413).json({
                error: 'Security metadata too large',
                message: `metadata must be <= ${MAX_METADATA_JSON_BYTES} bytes`,
            });
        }

        const userId = (req as any).user.uid;

        const event = {
            type,
            severity,
            message,
            metadata: safeMetadata,
            deviceId,
            userAgent,
            userId,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            source: 'frontend_via_backend'
        };

        await admin.firestore().collection('securityLogs').add(event);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error logging security event:', error);
        res.status(500).json({ error: 'Failed to log security event' });
    }
});

// Routes
// Liveness check as JSON (was an HTML "Backend is running" page that search engines could
// index). Stays 200 so existing uptime checks on "/" keep working; /api/health is the full check.
app.get('/', (_req, res) => {
    res.json({ status: 'ok' });
});

// Career Counselling — Mentors (public, no auth required)
app.get('/api/mentors', async (_req: Request, res: Response) => {
    try {
        const data = await fetchActiveMentors(resumeSupabase, resumeSupabase);
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
        res.status(200).json({ success: true, data });
    } catch (err) {
        console.error('[/api/mentors]', err);
        res.status(500).json({ success: false, error: 'Could not load mentors' });
    }
});

// Career Counselling — Book a session (deprecated — use /api/counselling/book)
app.post('/api/bookings', express.json({ limit: '10kb' }), verifyToken, (_req: Request, res: Response) => {
    res.status(410).json({
        success: false,
        error: 'DEPRECATED',
        message: 'This booking endpoint is no longer available. Use career counselling booking instead.',
    });
});

// Health Check Endpoint
app.get('/api/health', async (_req, res) => {
    const checks: Record<string, 'ok' | 'error' | 'skipped'> = {};

    // Check Firestore
    try {
        await admin.firestore().collection('_health').limit(1).get();
        checks.firestore = 'ok';
    } catch {
        checks.firestore = 'error';
    }

    // Check Supabase
    try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !supabaseKey) throw new Error('missing config');
        const response = await fetch(`${supabaseUrl}/rest/v1/`, {
            headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
            signal: AbortSignal.timeout(3000),
        });
        checks.supabase = response.ok ? 'ok' : 'error';
    } catch {
        checks.supabase = 'error';
    }

    checks.redis = await checkRateLimitRedisHealth();

    const { checkJobsSearchRpcHealth } = await import('./jobs-portal/healthCheck');
    checks.jobsSearch = await checkJobsSearchRpcHealth();

    const coreOk = checks.firestore === 'ok' && checks.supabase === 'ok';
    const redisFailure = checks.redis === 'error';

    let httpStatus = 200;
    let status: 'ok' | 'degraded' = 'ok';

    if (!coreOk) {
        httpStatus = 503;
        status = 'degraded';
    } else if (redisFailure && isRateLimitRedisRequired()) {
        console.error('[health] Redis required but unavailable', {
            backend: getRateLimitBackend(),
            checks: checks.redis,
        });
        httpStatus = 503;
        status = 'degraded';
    } else if (redisFailure) {
        // Fail-open: API usable, but distributed rate limits may be degraded.
        httpStatus = 200;
        status = 'degraded';
    } else if (checks.jobsSearch === 'error') {
        httpStatus = 200;
        status = 'degraded';
    }

    res.status(httpStatus).json({
        status,
        checks,
        rateLimitBackend: getRateLimitBackend(),
        timestamp: new Date().toISOString(),
    });
});

// Pre-parse workers.csv after deploy or CSV update (Vercel Cron + manual script).
app.get('/api/internal/warm-sponsorship', async (req: Request, res: Response) => {
    const { isAuthorizedInternalCron } = await import('./lib/internalCronAuth');
    if (!isAuthorizedInternalCron(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const force = req.query.force === '1' || req.query.force === 'true';
        const [uk, ireland] = await Promise.all([
            warmSponsorshipCache(force),
            warmIrelandSponsorshipCache(force),
        ]);
        console.log('[warm-sponsorship] UK cache ready', uk);
        console.log('[warm-sponsorship] Ireland cache ready', ireland);
        return res.status(200).json({ ok: true, uk, ireland });
    } catch (err) {
        console.error('[warm-sponsorship] Failed', err);
        const { captureServerError } = await import('./lib/observability/sentry');
        captureServerError(err, { tags: { route: 'warm-sponsorship' } });
        return res.status(500).json({ error: 'Failed to warm sponsorship cache' });
    }
});

app.get('/api/internal/sync-directory-employers', async (req: Request, res: Response) => {
    const { isAuthorizedInternalCron } = await import('./lib/internalCronAuth');
    if (!isAuthorizedInternalCron(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const result = await syncDirectoryEmployers();
        console.log('[sync-directory-employers]', result);
        return res.status(200).json(result);
    } catch (err) {
        console.error('[sync-directory-employers] Failed', err);
        const { captureServerError } = await import('./lib/observability/sentry');
        captureServerError(err, { tags: { route: 'sync-directory-employers' } });
        return res.status(500).json({ error: 'Failed to sync directory employers' });
    }
});

async function handleJobsCatalogSynced(req: Request, res: Response): Promise<void> {
    const { isAuthorizedInternalCron } = await import('./lib/internalCronAuth');
    if (!isAuthorizedInternalCron(req)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    try {
        const result = await invalidateJobsCatalogCaches();
        console.log('[jobs-catalog-synced] Caches invalidated', result);

        try {
            const { clearCompanyJobCountsCache } = await import('./jobs-portal/companiesDirectory');
            await clearCompanyJobCountsCache();
        } catch (cacheErr) {
            console.warn('[jobs-catalog-synced] company directory cache clear failed:', cacheErr);
        }

        try {
            const { warmPublicPartTimePreview } = await import('./jobs-portal/publicPreview/service');
            await warmPublicPartTimePreview();
        } catch (warmErr) {
            console.warn('[jobs-catalog-synced] public part-time preview warm failed:', warmErr);
        }

        if (process.env.NODE_ENV === 'production' && !result.redisAvailable) {
            const { captureServerWarning } = await import('./lib/observability/sentry');
            captureServerWarning('Jobs catalog cache invalidation ran without Redis', {
                tags: { route: 'jobs-catalog-synced', area: 'jobs-portal' },
                extra: result,
            });
        }

        res.status(200).json({ ok: true, ...result });
    } catch (err) {
        console.error('[jobs-catalog-synced] Failed', err);
        const { captureServerError } = await import('./lib/observability/sentry');
        captureServerError(err, { tags: { route: 'jobs-catalog-synced' } });
        res.status(500).json({ error: 'Failed to invalidate jobs catalog caches' });
    }
}

// Invalidate browse/search Redis caches after nightly jobs table refresh.
// GET: Vercel Cron (automatic). POST: call manually from an ETL script after sync.
app.get('/api/internal/jobs-catalog-synced', handleJobsCatalogSynced);
app.post('/api/internal/jobs-catalog-synced', handleJobsCatalogSynced);

app.get('/api/internal/email-outbox', async (req: Request, res: Response) => {
    const { isAuthorizedInternalCron } = await import('./lib/internalCronAuth');
    if (!isAuthorizedInternalCron(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const { processEmailOutbox } = await import('./email/worker');
        const result = await processEmailOutbox();
        console.log('[email-outbox]', result);
        return res.status(200).json({ ok: true, ...result });
    } catch (err) {
        console.error('[email-outbox] Failed', err);
        const { captureServerError } = await import('./lib/observability/sentry');
        captureServerError(err, { tags: { route: 'email-outbox' } });
        return res.status(500).json({ error: 'Failed to process email outbox' });
    }
});

// CAFY chat agent: daily deletion of the agent's own expired documents (chats, CV analyses, feedback).
app.get('/api/internal/agent-retention', async (req: Request, res: Response) => {
    const { isAuthorizedInternalCron } = await import('./lib/internalCronAuth');
    if (!isAuthorizedInternalCron(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const { runAgentRetention } = await import('./agent/retention');
        const result = await runAgentRetention();
        console.log('[agent-retention]', result);
        return res.status(result.errors.length ? 500 : 200).json({ ok: !result.errors.length, ...result });
    } catch (err) {
        console.error('[agent-retention] Failed', (err as { code?: unknown })?.code ?? 'error');
        return res.status(500).json({ error: 'Failed to run agent retention' });
    }
});

// CAFY chat agent: daily cost and usage totals (counts only, no user data). Same secret as the crons.
app.get('/api/internal/agent-usage', async (req: Request, res: Response) => {
    const { isAuthorizedInternalCron } = await import('./lib/internalCronAuth');
    if (!isAuthorizedInternalCron(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const { getJobsPortalRedis } = await import('./jobs-portal/redisClient');
    const redis = getJobsPortalRedis();
    if (!redis) return res.status(503).json({ error: 'Usage store unavailable' });
    const { readDailyUsage } = await import('./agent/usage');
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '7'), 10) || 7, 1), 90);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ days: await readDailyUsage(redis, days) });
});

app.get('/api/internal/email-campaigns', async (req: Request, res: Response) => {
    const { isAuthorizedInternalCron } = await import('./lib/internalCronAuth');
    if (!isAuthorizedInternalCron(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const { runEmailCampaignsCron } = await import('./email/cron');
        const result = await runEmailCampaignsCron();
        console.log('[email-campaigns]', result);
        return res.status(200).json({ ok: true, ...result });
    } catch (err) {
        console.error('[email-campaigns] Failed', err);
        const { captureServerError } = await import('./lib/observability/sentry');
        captureServerError(err, { tags: { route: 'email-campaigns' } });
        return res.status(500).json({ error: 'Failed to run email campaigns' });
    }
});

// Resume file upload — raw body parser MUST run before global express.json().
app.post('/api/storage/upload', express.raw({ type: '*/*', limit: '2mb' }), verifyToken, async (req: Request, res: Response) => {
    try {
        let path = (req.query.path as string) || '';
        if (path.startsWith('supabase:ProductResumes/')) {
            path = path.replace('supabase:ProductResumes/', '');
        }

        const userId = (req as any).user.uid;
        if (!path || typeof path !== 'string' || !path.startsWith(`${userId}/`)) {
            return res.status(403).json({ error: 'Access denied: You can only upload to your own folder.' });
        }

        // Strip characters Supabase Storage rejects (e.g. brackets in Resume[].pdf)
        path = storageService.sanitizeStorageObjectPath(path);
        if (!path.startsWith(`${userId}/`) || path === `${userId}/` || path.endsWith('/')) {
            return res.status(400).json({
                error: 'Invalid file name. Please rename your file (letters, numbers, dashes only) and try again.',
            });
        }

        let contentType = (req.headers['content-type'] || '').split(';')[0].trim();
        const ALLOWED_TYPES = new Set([
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ]);
        if (!ALLOWED_TYPES.has(contentType)) {
            const ext = path.split('.').pop()?.toLowerCase();
            if (ext === 'pdf') contentType = 'application/pdf';
            else if (ext === 'docx') {
                contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            }
        }
        if (!ALLOWED_TYPES.has(contentType)) {
            return res.status(400).json({ error: 'Only PDF and Word documents (.pdf or .docx) are accepted.' });
        }

        const fileBuffer = req.body as Buffer;
        if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
            return res.status(400).json({ error: 'No file data received.' });
        }

        const MAGIC: Record<string, number[]> = {
            'application/pdf': [0x25, 0x50, 0x44, 0x46],
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [0x50, 0x4B, 0x03, 0x04],
        };
        const magic = MAGIC[contentType];
        const validMagic = magic && magic.every((byte, i) => fileBuffer[i] === byte);
        if (!validMagic) {
            return res.status(400).json({ error: 'File content does not match the declared type.' });
        }

        const result = await storageService.uploadFile(path, fileBuffer, contentType);
        return res.status(200).json({ success: true, path: result.path });
    } catch (error: any) {
        console.error('Error uploading file:', error);
        const status = error?.statusCode ?? error?.status;
        const message = String(error?.message || error || '');
        if (status === 400 || /bad request|invalid.*(key|path|name)/i.test(message)) {
            return res.status(400).json({
                error: 'Invalid file name. Please rename your file (letters, numbers, dashes only) and try again.',
            });
        }
        return res.status(500).json({ error: 'Failed to upload resume' });
    }
});

// Default small limit for all other JSON routes.
app.use(express.json({ limit: '10kb' })); 

/** GA4 conversions from the apps (sign_up, activation) and the visitor link used for purchases. */
app.post('/api/analytics/event', verifyToken, handleAnalyticsEvent);

/** Secure: clients send operation + input only; server owns prompts and Gemini settings. */
app.post('/api/ai/generate', verifyToken, aiLimiter, handleSecureGenerate);

/** Dedicated UK Career Path Analysis endpoint. */
app.post('/api/ai/career-analysis', verifyToken, aiLimiter, handleCareerAnalysis);

// CAFY chat agent (streams Server-Sent Events)
app.post('/api/agent/turn', verifyToken, aiLimiter, handleAgentTurn);
app.get('/api/agent/conversations', verifyToken, conversationHandlers.list);
app.get('/api/agent/conversations/:id', verifyToken, conversationHandlers.get);
app.delete('/api/agent/conversations/:id', verifyToken, conversationHandlers.remove);
app.post('/api/agent/feedback', verifyToken, handleAgentFeedback);
app.post('/api/agent/cv-cleanup', verifyToken, handleAgentCvCleanup);
// CV tailoring ("/cv" in the chat): questions about the job, then the tailored CV. Nothing is stored.
app.post('/api/agent/cv-tailor/questions', verifyToken, aiLimiter, cvTailorHandlers.questions);
app.post('/api/agent/cv-tailor/build', verifyToken, aiLimiter, cvTailorHandlers.build);

/** Extract PDF text for Career Path (and similar). Unreadable PDFs → 422, not 500. */
app.post('/api/ai/extract-pdf', express.raw({ type: 'application/pdf', limit: '2mb' }), verifyToken, async (req: Request, res: Response) => {
    try {
        const fileBuffer = req.body as Buffer;
        if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
            return res.status(400).json({
                error: 'INVALID_PDF',
                message: 'No file data received.',
            });
        }

        // Validate Magic Number for PDF (%PDF)
        if (fileBuffer[0] !== 0x25 || fileBuffer[1] !== 0x50 || fileBuffer[2] !== 0x44 || fileBuffer[3] !== 0x46) {
            return res.status(400).json({
                error: 'INVALID_PDF',
                message: 'File content does not match PDF type.',
            });
        }

        // links: the PDF's hyperlink targets ("LinkedIn" → https://linkedin.com/in/...), which the text
        // alone doesn't contain. Additive field — existing callers that only read `text` are unaffected.
        const [text, links] = await Promise.all([extractPdfText(fileBuffer), extractPdfLinks(fileBuffer)]);
        return res.status(200).json({ text, links });
    } catch (error: unknown) {
        if (isPdfUnreadableError(error)) {
            console.warn('[extract-pdf] Unreadable PDF:', error.reason);
            return res.status(422).json({
                error: 'PDF_UNREADABLE',
                message: error.message,
                reason: error.reason,
            });
        }
        console.error('Error extracting PDF text:', error);
        const message =
            error instanceof Error ? error.message : 'Failed to extract text from PDF.';
        return res.status(500).json({ error: 'PDF_EXTRACT_FAILED', message });
    }
});

/** Dedicated cover letter generation endpoint for the Chrome extension. */
app.post('/api/extension/cover-letter', verifyToken, aiLimiter, handleExtensionCoverLetter);

/** Dedicated LinkedIn profile optimizer endpoint for the Chrome extension. */
app.post('/api/extension/linkedin-optimizer', verifyToken, aiLimiter, handleExtensionLinkedinOptimizer);
app.post('/api/extension/linkedin-scan', verifyToken, handleExtensionLinkedinScan);
app.get('/api/extension/linkedin-profile', verifyToken, handleExtensionGetLinkedinProfile);

/** Job application autofill for the Chrome extension. */
app.post('/api/extension/autofill/profile', verifyToken, aiLimiter, handleExtensionAutofillProfile);
app.put('/api/extension/autofill/profile', verifyToken, handleExtensionAutofillProfileUpdate);
app.post('/api/extension/autofill/fill', verifyToken, aiLimiter, handleExtensionAutofillFill);

/** Cover letter & email history (list, get, delete). */
app.use('/api/communications', globalLimiter, createCommunicationsRouter(verifyToken));

/** Lifecycle email unsubscribe + cancel feedback (public). */
app.use('/api/email', emailPublicLimiter, createEmailRouter());

/** Career counselling — public status (no auth, works when feature flag is off). */
app.get('/api/counselling/public-config', globalLimiter, (_req: Request, res: Response) => {
    try {
        return res.status(200).json(getCounsellingPublicStatus());
    } catch (error) {
        console.error('[counselling] public-config error:', error);
        return res.status(500).json({ enabled: false, error: 'CONFIG_FAILED' });
    }
});

/** Career counselling — availability, booking, sessions list. */
app.use('/api/counselling', globalLimiter, createCounsellingRouter(verifyToken, resumeSupabase));
app.use(
    '/api/resources',
    globalLimiter,
    createResourcesRouter(verifyToken, resourcesDownloadLimiter)
);

// Turnstile Captcha Verification Endpoint
app.post('/api/verify-captcha', async (req: Request, res: Response) => {
    try {

        const { token, remoteIp } = req.body;

        if (!token) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: token'
            });
        }

        // Get client IP if not provided
        const clientIp = remoteIp || req.ip || req.socket.remoteAddress;

        // Verify the token with Cloudflare
        const verificationResult = await verifyTurnstileToken(token, clientIp);

        if (isTurnstileVerified(verificationResult)) {
            return res.status(200).json({
                success: true,
                message: 'Captcha verified successfully',
                data: {
                    challenge_ts: verificationResult.challenge_ts,
                    hostname: verificationResult.hostname,
                }
            });
        } else {
            return res.status(400).json({
                success: false,
                error: 'Captcha verification failed',
                errorCodes: verificationResult['error-codes'] || []
            });
        }
    } catch (error) {
        console.error('Error in /api/verify-captcha:', error);
        return res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Internal Server Error'
        });
    }
});


// Session Management Endpoints

// Verify Session — used by the extension to check if its stored cookie is still valid.
// Handles both raw idTokens (current) and Firebase session cookies (future).
app.get('/api/auth/verify-session', async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;

    if (!token) return res.status(401).json({ valid: false });

    // Try idToken first (primary — cookie currently stores raw idToken)
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        return res.status(200).json({ valid: true, email: decoded.email, uid: decoded.uid });
    } catch {}

    // Try session cookie (forward-compatible — ready for when session cookies are introduced)
    try {
        const decoded = await admin.auth().verifySessionCookie(token, true);
        return res.status(200).json({ valid: true, email: decoded.email, uid: decoded.uid });
    } catch {}

    return res.status(401).json({ valid: false });
});

app.post('/api/auth/session-login', async (req: Request, res: Response) => {
    try {
        const { idToken } = req.body;
        if (!idToken) {
            return res.status(400).json({ error: 'Missing idToken' });
        }

        // 1. Verify the incoming idToken
        const decodedToken = await admin.auth().verifyIdToken(idToken);

        // 2. Beta Access Check
        const { allowed, message } = checkBetaAccess(decodedToken.email);
        if (!allowed) {
            return res.status(403).json({
                success: false,
                error: 'BETA_ACCESS_DENIED',
                message
            });
        }

        // 3. Store the idToken directly in the HttpOnly cookie.
        //    The Product Site refreshes this via onIdTokenChanged (~every 1 hour),
        //    keeping the extension authenticated while the site is active.
        const expiresIn = 60 * 60 * 24 * 5 * 1000; // 5 days
        res.cookie('ext_auth', idToken, {
            maxAge: expiresIn,
            httpOnly: true,
            secure: true,      // Always secure for SameSite=None
            sameSite: 'none'   // Required for cross-site cookie access by the extension
        });

        if (decodedToken.email_verified) {
            const { ensureUserStub } = await import('./email/userStub');
            void ensureUserStub({
                uid: decodedToken.uid,
                email: decodedToken.email || null,
                displayName: typeof decodedToken.name === 'string' ? decodedToken.name : null,
            }).catch((err) => console.warn('[email] user stub failed:', err));
        }

        return res.status(200).json({ status: 'success', uid: decodedToken.uid });
    } catch (error: any) {
        console.error(`[session-login] FAILED - code=${error?.code} msg=${error?.message}`);
        return res.status(401).json({ error: 'Invalid token' });
    }
});

app.use('/api/billing', billingLimiter, createBillingRouter(verifyToken));
// Assert and delete must not share one IP bucket (assert runs before Auth uid is known).
app.use('/api/account/assert-signup-allowed', accountAssertSignupLimiter);
app.use('/api/account/delete', accountDeleteLimiter);
app.use('/api/account', createAccountRouter(verifyToken));

// Usage Tracking Endpoints
app.get('/api/usage-status', verifyToken, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.uid;
        const usageStatus = await getUserUsageStatus(userId);
        return res.status(200).json(usageStatus);
    } catch (error) {
        console.error('Error fetching usage status:', error);
        return res.status(500).json({ error: 'Failed to fetch usage status' });
    }
});

app.post('/api/usage/check-and-increment', verifyToken, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.uid;
        const { timezone } = req.body;

        if (!timezone) {
            return res.status(400).json({ error: 'Missing timezone in request body' });
        }

        const result = await checkAndIncrementUsage(userId, timezone);

        if (!result.allowed) {
            return res.status(429).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        console.error('Error in check-and-increment:', error);
        return res.status(500).json({ error: 'Failed to update usage count' });
    }
});

// Job Management Endpoints
app.post('/api/jobs/add', verifyToken, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.uid;
        const result = await addJob(userId, req.body);

        if (result.success) {
            return res.status(201).json(result);
        } else {
            // Check for specific error types if needed, but for now 400 is appropriate for validation failures
            if (result.errors) {
                return res.status(400).json(result);
            } else {
                return res.status(500).json(result);
            }
        }
    } catch (error) {
        console.error('Error in /api/jobs/add endpoint:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to add job',
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

// Public job preview — the ONLY unauthenticated jobs route. Mounted BEFORE verifyToken.
// Order: cheap IP limits → strict query validation → Turnstile (network call) → cached feed.
// Returns max 15 jobs, no apply URLs, no pagination/search (see jobs-portal/publicPreview).
app.get(
    '/api/jobs-portal/public-preview',
    publicPreviewMinuteLimiter,
    publicPreviewDailyLimiter,
    (req: Request, res: Response, next) => {
        const query = parsePublicPreviewQuery(req.query, req.originalUrl);
        if (!query) {
            return res.status(400).json({ error: 'Invalid request' });
        }
        res.locals.publicPreviewQuery = query;
        return next();
    },
    requireTurnstileToken,
    async (_req: Request, res: Response) => {
        try {
            const payload = await getPublicPreview(res.locals.publicPreviewQuery);
            return res.status(200).json(payload);
        } catch (error) {
            Sentry.captureException(error, { tags: { route: 'public-preview', area: 'public-jobs' } });
            console.error('[public-preview] error:', error);
            return res.status(503).json({ error: 'Jobs temporarily unavailable' });
        }
    }
);

// Public UK part-time preview — same protections as above (shared limiter buckets).
// All-UK only, 15 jobs. No parameters accepted: location filter, search and paging need login.
app.get(
    '/api/jobs-portal/public-preview/part-time',
    publicPreviewMinuteLimiter,
    publicPreviewDailyLimiter,
    (req: Request, res: Response, next) => {
        if (!isValidPublicPartTimeQuery(req.query, req.originalUrl)) {
            return res.status(400).json({ error: 'Invalid request' });
        }
        return next();
    },
    requireTurnstileToken,
    async (_req: Request, res: Response) => {
        try {
            const payload = await getPublicPartTimePreview();
            return res.status(200).json(payload);
        } catch (error) {
            Sentry.captureException(error, { tags: { route: 'public-preview-part-time', area: 'public-jobs' } });
            console.error('[public-preview/part-time] error:', error);
            return res.status(503).json({ error: 'Jobs temporarily unavailable' });
        }
    }
);

// Jobs Portal Endpoints (new — all routes protected by verifyToken)
app.use('/api/jobs-portal', verifyToken, jobsPortalRouter);

// Storage Bridge Endpoints
app.post('/api/storage/sign-url', verifyToken, async (req: Request, res: Response) => {
    try {
        let { path } = req.body;
        if (path.startsWith('supabase:ProductResumes/')) {
            path = path.replace('supabase:ProductResumes/', '');
        }

        // Verify path starts with uid/ to ensure user can only access their own files
        const uid = (req as any).user.uid;
        if (!path.startsWith(`${uid}/`)) {
            console.warn(`Access denied for user ${uid} attempting to access path ${path}`);
            return res.status(403).json({ error: 'Access denied' });
        }

        const signedUrl = await storageService.getSignedUrl(path);
        res.json({ signedUrl });
    } catch (error) {
        console.error('Error generating signed URL:', error);
        res.status(500).json({ error: 'Failed to generate signed URL' });
    }
});

app.post('/api/storage/delete', verifyToken, async (req: Request, res: Response) => {
    try {
        let { path } = req.body;
        if (path.startsWith('supabase:ProductResumes/')) {
            path = path.replace('supabase:ProductResumes/', '');
        }

        const userId = (req as any).user.uid;
        // Security check: Ensure user can only delete their own folder
        if (!path.startsWith(`${userId}/`)) {
            return res.status(403).json({ error: 'Access denied: You can only delete your own resumes.' });
        }

        await storageService.deleteFile(path);
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error deleting file:', error);
        return res.status(500).json({ error: 'Failed to delete resume' });
    }
});

app.post('/api/auth/session-logout', async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await admin.auth().verifyIdToken(token);
    } catch (err: any) {
        if (err?.code !== 'auth/id-token-expired') {
            return res.status(401).json({ error: 'Invalid token' });
        }
    }

    res.clearCookie('ext_auth', {
        httpOnly: true,
        secure: true,
        sameSite: 'none'
    });
    return res.status(200).json({ status: 'success' });
});

// Sentry error handler — must be before the custom error handler
Sentry.setupExpressErrorHandler(app);

// Global Error Handling Middleware (The Safety Net)
app.use((err: any, _req: Request, res: Response, _next: any) => {
    // express.json / express.raw body size limit
    if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
        console.error('ERROR [413]: Request entity too large');
        return res.status(413).json({
            success: false,
            error: 'PAYLOAD_TOO_LARGE',
            message:
                'Request body is too large. For career analysis, keep resume text under 100,000 characters (PDF/DOCX under 2MB).',
        });
    }

    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal Server Error';

    console.error(`ERROR [${status}]: ${message}`);

    res.status(status).json({
        success: false,
        error: message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

export default app;

// Expire abandoned slot holds periodically (also runs on-demand in API handlers).
startCounsellingMaintenanceCron();

// Vercel serverless config (must live on the entry file when using `builds` in vercel.json).
export const config = {
    maxDuration: 60,
    memory: 1024,
};

// Local / non-Vercel: start HTTP server. Vercel sets VERCEL=1 and uses the exported app.
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}
