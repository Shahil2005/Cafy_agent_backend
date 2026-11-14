import { Router, Request, Response } from 'express';
import * as admin from 'firebase-admin';
import { isStripeConfigured } from './stripeClient';
import { isBillingEnabled as billingFlag } from './config';
import { createCheckoutSession, createPortalSession } from './checkoutService';
import { cancelUserStripeSubscription } from './cancelService';
import { buildBillingStatus } from './entitlements';
import { handleStripeWebhook } from './webhookService';
import {
    ensurePlanSelectionMigrated,
    getPlanSelection,
    selectFreePlan,
    completePlanSelectionFromPremium,
} from './planSelectionService';
import {
    getUserBillingDoc,
    refreshSubscriptionIfExpired,
    isJobsPremiumActive,
    isPartTimePremiumActive,
    isFullPremiumActive,
} from './subscriptionService';
import { isResumeToolBillingEnabled } from './resumeToolConfig';
import {
    getCachedBillingStatusPayload,
    setCachedBillingStatusPayload,
} from './statusCache';
import { logBillingStatusReads } from './readMetrics';
import { isResumeToolOperation } from './resumeToolOperations';
import { reserveResumeUsage, refundResumeUsage } from './resumeToolUsage';
import { ResumeReservationError, isResumeReservationId } from './resumeToolReservation';
import { isAiCallCategory, isAiCallSource } from './aiCallCategories';
import { normalizeAiProvider, recordAiCallForUser } from './aiCallTracking';
import { buildPlanCatalogResponse } from './planCatalog';
import {
    previewWeeklyUpgrade,
    executeWeeklyUpgrade,
    WeeklyUpgradePaymentError,
    InvalidPromoCodeError,
} from './upgradeService';
import { isJobsWeeklyEnabled, isPartTimeWeeklyEnabled } from './config';
import { captureServerError } from '../lib/observability/sentry';

function formatSubscribedPlanName(billing: Awaited<ReturnType<typeof buildBillingStatus>>): string {
    if (billing.productTier === 'part_time' || billing.plan === 'part_time') {
        return 'Part-time Weekly (UK)';
    }
    if (billing.productTier === 'jobs_only' || billing.plan === 'jobs_premium') {
        if (billing.billingInterval === 'monthly') return 'Jobs Premium Monthly';
        return 'Jobs Premium Weekly';
    }
    if (billing.billingInterval === 'quarterly') return 'Premium 3-month';
    if (billing.billingInterval === 'monthly') return 'Premium Monthly';
    return 'Premium';
}

function upgradesEnabled(): boolean {
    return isJobsWeeklyEnabled() || isPartTimeWeeklyEnabled();
}

type VerifyToken = (req: Request, res: Response, next: () => void) => Promise<void | Response>;

export function createBillingRouter(verifyToken: VerifyToken): Router {
    const router = Router();

    /** Public plan limits + live Stripe prices for pricing UI (Cafy Product + Resume studio). */
    router.get('/plan-catalog', async (_req: Request, res: Response) => {
        try {
            return res.status(200).json(await buildPlanCatalogResponse());
        } catch (error) {
            console.error('[billing] plan-catalog error:', error);
            captureServerError(error, { tags: { route: 'billing-plan-catalog' } });
            return res.status(500).json({ error: 'Failed to load plan catalog' });
        }
    });

    router.get('/status', verifyToken, async (req: Request, res: Response) => {
        try {
            const uid = (req as any).user.uid;
            const syncStripe = req.query.sync === '1';

            if (!syncStripe) {
                const cached = getCachedBillingStatusPayload(uid);
                if (cached) {
                    logBillingStatusReads({
                        uid,
                        userDocReads: 0,
                        cacheHit: true,
                        syncStripe: false,
                    });
                    return res.status(200).json(cached);
                }
            }

            // One users/{uid} read shared by plan-selection + billing status.
            const userSnap = await admin.firestore().doc(`users/${uid}`).get();
            let userDocReads = 1;
            const planSelection = await ensurePlanSelectionMigrated(uid, userSnap);
            const status = await buildBillingStatus(uid, {
                syncStripe,
                preloaded: userSnap,
                email: (req as any).user.email,
                onUserDocRead: () => {
                    userDocReads += 1;
                },
            });
            const payload = { ...status, planSelection };
            if (!syncStripe) {
                setCachedBillingStatusPayload(uid, payload);
            }
            logBillingStatusReads({
                uid,
                userDocReads,
                cacheHit: false,
                syncStripe,
            });
            return res.status(200).json(payload);
        } catch (error) {
            console.error('[billing] status error:', error);
            return res.status(500).json({ error: 'Failed to fetch billing status' });
        }
    });

    router.get('/plan-selection', verifyToken, async (req: Request, res: Response) => {
        try {
            const uid = (req as any).user.uid;
            const userSnap = await admin.firestore().doc(`users/${uid}`).get();
            const userData = userSnap.data() || {};
            if (userData.requiresPlanSelection === true) {
                const { subscription: fromSnap } = await getUserBillingDoc(uid, userSnap);
                const subscription = await refreshSubscriptionIfExpired(uid, fromSnap);
                return res.status(200).json({
                    planSelection: { completed: false },
                    isPremium: isFullPremiumActive(subscription),
                    isJobsPremium: isJobsPremiumActive(subscription),
                    isPartTimePremium: isPartTimePremiumActive(subscription),
                });
            }
            const planSelection = await ensurePlanSelectionMigrated(uid, userSnap);
            return res.status(200).json({ planSelection });
        } catch (error) {
            console.error('[billing] plan-selection error:', error);
            return res.status(500).json({ error: 'Failed to fetch plan selection' });
        }
    });

    router.post('/select-free-plan', verifyToken, async (req: Request, res: Response) => {
        try {
            const uid = (req as any).user.uid;
            const existing = await getPlanSelection(uid);
            if (existing.completed) {
                return res.status(200).json({ planSelection: existing });
            }
            const planSelection = await selectFreePlan(uid);
            return res.status(200).json({ planSelection });
        } catch (error) {
            console.error('[billing] select-free-plan error:', error);
            return res.status(500).json({ error: 'Failed to select free plan' });
        }
    });

    router.post('/complete-plan-selection', verifyToken, async (req: Request, res: Response) => {
        try {
            const uid = (req as any).user.uid;
            const billing = await buildBillingStatus(uid, { email: (req as any).user.email });
            if (!billing.isJobsPremium && !billing.isPartTimePremium) {
                return res.status(400).json({
                    error: 'PREMIUM_NOT_ACTIVE',
                    message: 'Premium is not active yet. Wait a moment and try again.',
                });
            }
            const { subscription } = await getUserBillingDoc(uid);
            const planSelection = await completePlanSelectionFromPremium(uid, subscription.priceId);
            return res.status(200).json({ planSelection, billing });
        } catch (error) {
            console.error('[billing] complete-plan-selection error:', error);
            return res.status(500).json({ error: 'Failed to complete plan selection' });
        }
    });

    router.post('/create-checkout', verifyToken, async (req: Request, res: Response) => {
        if (!billingFlag() || !isStripeConfigured()) {
            return res.status(503).json({ error: 'Billing is not configured' });
        }
        try {
            const uid = (req as any).user.uid;
            const email = (req as any).user.email as string | undefined;
            const { priceId, onboarding, returnApp, promotionCode } = req.body;
            if (!priceId || typeof priceId !== 'string') {
                return res.status(400).json({ error: 'Missing priceId' });
            }
            const checkoutReturnApp = returnApp === 'resume-tool' ? 'resume-tool' : 'cafy';
            const result = await createCheckoutSession(uid, email, priceId, {
                onboarding: onboarding === true,
                returnApp: checkoutReturnApp,
                promotionCode: typeof promotionCode === 'string' ? promotionCode : null,
            });
            return res.status(200).json(result);
        } catch (error: any) {
            if (error.message === 'ALREADY_SUBSCRIBED') {
                const uid = (req as any).user.uid;
                const billing = await buildBillingStatus(uid, { email: (req as any).user.email });
                const planName = formatSubscribedPlanName(billing);
                return res.status(409).json({
                    error: 'ALREADY_SUBSCRIBED',
                    message: `You are already subscribed to ${planName}. Use Manage billing or upgrade options — you cannot start a second checkout.`,
                    billing,
                });
            }
            if (error.message === 'INVALID_PRICE_ID') {
                return res.status(400).json({ error: 'Invalid plan selected' });
            }
            if (error.message === 'PART_TIME_UK_ONLY') {
                return res.status(403).json({
                    error: 'PART_TIME_UK_ONLY',
                    message: 'The Part-time Weekly plan is available for United Kingdom profiles only.',
                });
            }
            if (typeof error.message === 'string' && error.message.startsWith('PRICE_NOT_GBP')) {
                return res.status(400).json({
                    error: 'BILLING_GBP_ONLY',
                    message:
                        'Billing is configured for UK pounds (GBP) only. Update Stripe price IDs in server environment to GBP prices.',
                });
            }
            if (error.message === 'BILLING_BALANCE_CLEAR_FAILED') {
                return res.status(503).json({
                    error: 'BILLING_BALANCE_CLEAR_FAILED',
                    message: 'We could not prepare billing safely. Please try again in a moment.',
                });
            }
            console.error('[billing] create-checkout error:', error);
            return res.status(500).json({ error: 'Failed to create checkout session' });
        }
    });

    router.get('/upgrade-preview', verifyToken, async (req: Request, res: Response) => {
        if (!billingFlag() || !isStripeConfigured() || !upgradesEnabled()) {
            return res.status(503).json({ error: 'UPGRADES_DISABLED' });
        }
        try {
            const uid = (req as any).user.uid;
            const targetPriceId = req.query.targetPriceId;
            if (typeof targetPriceId !== 'string' || !targetPriceId) {
                return res.status(400).json({ error: 'Missing targetPriceId' });
            }
            const promoCodeRaw = req.query.promoCode;
            const promoCode = typeof promoCodeRaw === 'string' && promoCodeRaw.trim() ? promoCodeRaw : null;
            const preview = await previewWeeklyUpgrade(uid, targetPriceId, promoCode);
            return res.status(200).json(preview);
        } catch (error: any) {
            if (error instanceof InvalidPromoCodeError) {
                return res.status(400).json({ error: 'INVALID_PROMO_CODE', message: error.message });
            }
            const message = error?.message || 'UPGRADE_PREVIEW_FAILED';
            const status =
                message === 'NOT_JOBS_PREMIUM' ||
                message === 'NOT_UPGRADEABLE_PLAN' ||
                message === 'NOT_ACTIVE_SUBSCRIPTION' ||
                message === 'INVALID_UPGRADE_TARGET'
                    ? 400
                    : message === 'ALREADY_FULL_PREMIUM'
                      ? 409
                      : 500;
            return res.status(status).json({ error: message });
        }
    });

    router.post('/upgrade-from-weekly', verifyToken, async (req: Request, res: Response) => {
        if (!billingFlag() || !isStripeConfigured() || !upgradesEnabled()) {
            return res.status(503).json({ error: 'UPGRADES_DISABLED' });
        }
        try {
            const uid = (req as any).user.uid;
            const { targetPriceId, promoCode: promoCodeRaw } = req.body;
            if (!targetPriceId || typeof targetPriceId !== 'string') {
                return res.status(400).json({ error: 'Missing targetPriceId' });
            }
            const promoCode = typeof promoCodeRaw === 'string' && promoCodeRaw.trim() ? promoCodeRaw : null;
            const result = await executeWeeklyUpgrade(uid, targetPriceId, promoCode);
            const billing = await buildBillingStatus(uid, { syncStripe: true, email: (req as any).user.email });
            return res.status(200).json({ ...result, billing });
        } catch (error: any) {
            if (error instanceof InvalidPromoCodeError) {
                return res.status(400).json({ error: 'INVALID_PROMO_CODE', message: error.message });
            }
            if (error instanceof WeeklyUpgradePaymentError) {
                return res.status(402).json({
                    error: error.code,
                    message: error.message,
                    hostedInvoiceUrl: error.hostedInvoiceUrl,
                });
            }
            const message = error?.message || 'UPGRADE_FAILED';
            const status =
                message === 'NOT_JOBS_PREMIUM' ||
                message === 'NOT_UPGRADEABLE_PLAN' ||
                message === 'NOT_ACTIVE_SUBSCRIPTION' ||
                message === 'INVALID_UPGRADE_TARGET'
                    ? 400
                    : message === 'ALREADY_FULL_PREMIUM' || message === 'UPGRADE_IN_PROGRESS'
                      ? 409
                      : 500;
            console.error('[billing] upgrade-from-weekly error:', error);
            return res.status(status).json({
                error: message,
                message:
                    message === 'UPGRADE_IN_PROGRESS'
                        ? 'An upgrade payment is already in progress. Finish bank verification or wait a moment, then try again.'
                        : undefined,
            });
        }
    });

    router.post('/create-portal', verifyToken, async (req: Request, res: Response) => {
        if (!billingFlag() || !isStripeConfigured()) {
            return res.status(503).json({ error: 'Billing is not configured' });
        }
        try {
            const uid = (req as any).user.uid;
            const email = (req as any).user.email as string | undefined;
            const returnApp = req.body?.returnApp === 'resume-tool' ? 'resume-tool' : 'cafy';
            const flow =
                req.body?.flow === 'cancel' || req.body?.flow === 'update_card'
                    ? req.body.flow
                    : undefined;
            const result = await createPortalSession(uid, email, { returnApp, flow });
            return res.status(200).json(result);
        } catch (error: any) {
            if (error.message === 'NO_STRIPE_CUSTOMER') {
                return res.status(400).json({ error: 'No subscription to manage' });
            }
            if (error.message === 'PORTAL_NOT_CONFIGURED') {
                return res.status(503).json({
                    error: 'PORTAL_NOT_CONFIGURED',
                    message:
                        'Stripe Customer Portal is not configured. In Stripe Dashboard go to Settings → Billing → Customer portal and activate it.',
                });
            }
            if (error.message === 'PORTAL_URL_MISSING' || error.message === 'PORTAL_URL_INVALID') {
                return res.status(502).json({
                    error: 'PORTAL_URL_INVALID',
                    message: 'Could not open billing portal. Please try again or contact support.',
                });
            }
            console.error('[billing] create-portal error:', error);
            return res.status(500).json({ error: 'Failed to open billing portal' });
        }
    });

    router.post('/cancel-subscription', verifyToken, async (req: Request, res: Response) => {
        if (!billingFlag() || !isStripeConfigured()) {
            return res.status(503).json({ error: 'Billing is not configured' });
        }
        try {
            const uid = (req as any).user.uid;
            const result = await cancelUserStripeSubscription(uid, (req as any).user.email, {
                immediate: req.body?.immediate === true,
            });
            const billing = await buildBillingStatus(uid, {
                syncStripe: true,
                email: (req as any).user.email,
            });
            return res.status(200).json({ ...result, billing });
        } catch (error: any) {
            if (error?.message === 'NO_STRIPE_SUBSCRIPTION') {
                return res.status(400).json({ error: 'No subscription to cancel' });
            }
            console.error('[billing] cancel-subscription error:', error);
            return res.status(500).json({ error: 'Failed to cancel subscription' });
        }
    });

    router.post('/resume-tool/reserve', verifyToken, async (req: Request, res: Response) => {
        if (!isResumeToolBillingEnabled()) {
            return res.status(503).json({ error: 'RESUME_BILLING_DISABLED' });
        }
        try {
            const uid = (req as any).user.uid;
            const { operation } = req.body;
            if (!isResumeToolOperation(operation)) {
                return res.status(400).json({
                    error: 'INVALID_OPERATION',
                    message: 'operation must be analyse, optimise, import, or pdf_download',
                });
            }
            const result = await reserveResumeUsage(uid, operation);
            if (!result.ok) {
                const status = result.errorCode === 'BILLING_DISABLED' ? 503 : 402;
                return res.status(status).json(result);
            }
            return res.status(200).json(result);
        } catch (error) {
            console.error('[billing] resume-tool reserve error:', error);
            return res.status(500).json({ error: 'Failed to reserve usage' });
        }
    });

    router.post('/resume-tool/refund', verifyToken, async (req: Request, res: Response) => {
        if (!isResumeToolBillingEnabled()) {
            return res.status(503).json({ error: 'RESUME_BILLING_DISABLED' });
        }
        try {
            const uid = (req as any).user.uid;
            const { operation, reservationId } = req.body ?? {};
            if (!isResumeToolOperation(operation) || !isResumeReservationId(reservationId)) {
                return res.status(400).json({ error: 'INVALID_RESERVATION' });
            }
            await refundResumeUsage(uid, operation, reservationId);
            return res.status(200).json({ ok: true });
        } catch (error) {
            if (error instanceof ResumeReservationError) {
                return res.status(400).json({ error: 'INVALID_RESERVATION' });
            }
            console.error('[billing] resume-tool refund error:', error);
            return res.status(500).json({ error: 'Failed to refund usage' });
        }
    });

    /** ResumeTool AI call logging — writes to users/{uid}/aiCalls for paid users. */
    router.post('/ai-calls/log', verifyToken, async (req: Request, res: Response) => {
        try {
            const uid = (req as any).user.uid;
            const {
                category,
                source,
                route,
                operation,
                subcategory,
                aiProvider,
                provider,
                model,
                status,
                latencyMs,
                attempts,
                fallbackUsed,
                promptTokenCount,
                candidatesTokenCount,
                totalTokenCount,
            } = req.body;

            if (!isAiCallCategory(category)) {
                return res.status(400).json({ error: 'INVALID_CATEGORY' });
            }
            if (!isAiCallSource(source)) {
                return res.status(400).json({ error: 'INVALID_SOURCE' });
            }
            const resolvedProvider = normalizeAiProvider(aiProvider ?? provider);
            if (!resolvedProvider) {
                return res.status(400).json({ error: 'INVALID_AI_PROVIDER' });
            }
            if (typeof model !== 'string' || !model) {
                return res.status(400).json({ error: 'INVALID_MODEL' });
            }
            if (status !== 'success' && status !== 'error') {
                return res.status(400).json({ error: 'INVALID_STATUS' });
            }

            const callId = await recordAiCallForUser(uid, {
                category,
                source,
                route: typeof route === 'string' ? route : undefined,
                operation: typeof operation === 'string' ? operation : undefined,
                subcategory: typeof subcategory === 'string' ? subcategory : undefined,
                aiProvider: resolvedProvider,
                model,
                status,
                latencyMs: typeof latencyMs === 'number' ? latencyMs : undefined,
                attempts: typeof attempts === 'number' ? attempts : undefined,
                fallbackUsed: fallbackUsed === true,
                promptTokenCount: typeof promptTokenCount === 'number' ? promptTokenCount : undefined,
                candidatesTokenCount:
                    typeof candidatesTokenCount === 'number' ? candidatesTokenCount : undefined,
                totalTokenCount: typeof totalTokenCount === 'number' ? totalTokenCount : undefined,
            });

            return res.status(200).json({ ok: true, logged: callId !== null, callId });
        } catch (error) {
            console.error('[billing] ai-calls log error:', error);
            return res.status(500).json({ error: 'Failed to log AI call' });
        }
    });

    return router;
}

export async function stripeWebhookHandler(req: Request, res: Response) {
    if (!billingFlag()) {
        return res.status(503).send('Billing disabled');
    }
    try {
        const sig = req.headers['stripe-signature'] as string | undefined;
        const rawBody = req.body as Buffer;
        if (!Buffer.isBuffer(rawBody)) {
            return res.status(400).send('Webhook requires raw body');
        }
        await handleStripeWebhook(rawBody, sig);
        return res.status(200).json({ received: true });
    } catch (error: any) {
        console.error('[billing] webhook error:', error.message);
        captureServerError(error, { tags: { route: 'stripe-webhook' } });
        return res.status(400).send(`Webhook Error: ${error.message}`);
    }
}
