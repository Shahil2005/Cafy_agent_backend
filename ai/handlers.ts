import { Request, Response } from 'express';
import { resolveAiOperation, isCommBillableOperation } from '../billing/aiOperations';
import { isBillingEnabled } from '../billing/config';
import type { AiCallCategory } from '../billing/aiCallCategories';
import { normalizeAiProvider, recordAiCallForUser } from '../billing/aiCallTracking';
import {
    reserveCommGeneration,
    refundCommGeneration,
    reserveExtensionCoverLetter,
    refundExtensionCoverLetter,
    isFullPremiumActive,
    refreshSubscriptionIfExpired,
} from '../billing/subscriptionService';
import { saveCommunicationFromGeneration } from '../communications/saveFromGeneration';
import { saveCommunicationMetaSchema } from '../communications/schema';
import { buildSecureGeminiRequest } from './buildRequest';
import type { GeminiRequestPayload } from './geminiCore';
import { executeAiGeneration } from './orchestrator';
import type { OrchestratorSuccess } from './types';
import { parseSecureInput } from './parseSecureInput';
import { commCoverLetterInputSchema } from './schemas/commCoverLetter';
import { linkedinOptimizerInputSchema } from './schemas/linkedinOptimizer';
import { wrapAsGeminiResponse } from './normalizeResponse';
import { computeInputHash, getStoredLinkedinProfile, saveOptimizationResult, saveScrapedProfile } from '../linkedinProfile/store';

type HandlerResult =
    | { status: number; body: unknown; aiMeta?: Pick<OrchestratorSuccess, 'provider' | 'model' | 'attempts' | 'latencyMs'> };

function scheduleAiCallLog(
    userId: string,
    category: AiCallCategory,
    source: 'product-site' | 'extension',
    route: string,
    operation: string,
    aiMeta: Pick<OrchestratorSuccess, 'provider' | 'model' | 'attempts' | 'latencyMs'>
): void {
    const aiProvider = normalizeAiProvider(aiMeta.provider);
    if (!aiProvider) return;

    void recordAiCallForUser(userId, {
        category,
        source,
        route,
        operation,
        aiProvider,
        model: aiMeta.model,
        status: 'success',
        latencyMs: aiMeta.latencyMs,
        attempts: aiMeta.attempts,
        fallbackUsed: aiMeta.attempts > 1,
    }).catch((err) => console.warn('[ai-calls] log failed:', err));
}

function parseSaveMeta(body: Record<string, unknown>) {
    if (body.meta === undefined || body.meta === null) return undefined;
    const parsed = saveCommunicationMetaSchema.safeParse(body.meta);
    return parsed.success ? parsed.data : undefined;
}

async function attachCommunicationHistory(
    userId: string,
    operation: 'comm_cover_letter' | 'comm_email',
    input: Parameters<typeof saveCommunicationFromGeneration>[0]['input'],
    responseBody: unknown,
    source: 'web' | 'extension',
    meta?: ReturnType<typeof parseSaveMeta>
): Promise<unknown> {
    if (responseBody === null || typeof responseBody !== 'object') return responseBody;

    try {
        const saved = await saveCommunicationFromGeneration({
            userId,
            operation,
            input,
            responseBody,
            source,
            meta,
        });

        if (!saved) return responseBody;

        return { ...(responseBody as Record<string, unknown>), commHistory: saved };
    } catch (err) {
        console.error('[communications] Failed to save generation:', err);
        return responseBody;
    }
}

async function executeGeneration(
    userId: string,
    operation: NonNullable<ReturnType<typeof resolveAiOperation>>,
    request: GeminiRequestPayload,
    commReserved: boolean,
    refundFn: (uid: string) => Promise<void> = refundCommGeneration,
    primaryModel?: string
): Promise<HandlerResult> {
    const result = await executeAiGeneration(operation, request, { primaryModel });

    if (!result.ok) {
        if (commReserved) {
            try {
                await refundFn(userId);
            } catch (refundErr) {
                console.error('[billing] Failed to refund usage:', refundErr);
            }
        }

        if (result.status === 500 && result.errorText === 'Server configuration error') {
            console.error('Missing GEMINI_API_KEY environment variable');
            return { status: 500, body: { error: 'Server configuration error' } };
        }

        console.error(`AI generation failed (${result.status}):`, result.errorText);

        if (result.status === 429) {
            return { status: 429, body: { error: 'Too Many Requests', details: result.errorText } };
        }

        return {
            status: result.status >= 400 && result.status < 600 ? result.status : 502,
            body: {
                error: 'AI generation failed',
                details: result.errorText,
            },
        };
    }

    return {
        status: 200,
        body: result.body,
        aiMeta: {
            provider: result.provider,
            model: result.model,
            attempts: result.attempts,
            latencyMs: result.latencyMs,
        },
    };
}

export async function handleSecureGenerate(req: Request, res: Response): Promise<void> {
    const userId = (req as Request & { user: { uid: string } }).user.uid;
    const parsed = parseSecureInput(req.body as Record<string, unknown>);

    if (!parsed.ok) {
        res.status(400).json({
            error: parsed.error,
            message: parsed.message,
            ...(parsed.details !== undefined ? { details: parsed.details } : {}),
        });
        return;
    }

    const { operation } = parsed.data;
    const request = buildSecureGeminiRequest(parsed.data);
    const body = req.body as Record<string, unknown>;
    const primaryModel =
        typeof body.primaryModel === 'string' ? body.primaryModel.trim() : undefined;

    const billComm = isBillingEnabled() && isCommBillableOperation(operation);
    let commReserved = false;
    let usageNudge: { used: number; limit: number; remaining: number } | null = null;

    if (billComm) {
        const reserve = await reserveCommGeneration(userId);
        if (!reserve.ok) {
            res.status(402).json({
                error: reserve.reason,
                message: reserve.message,
                used: reserve.used,
                limit: reserve.limit,
                remaining: reserve.remaining,
            });
            return;
        }
        commReserved = !reserve.isPremium;
        if (reserve.ok && !reserve.isPremium && reserve.remaining === 1) {
            usageNudge = { used: reserve.used, limit: reserve.limit, remaining: reserve.remaining };
        }
    }

    try {
        const outcome = await executeGeneration(userId, operation, request, commReserved, refundCommGeneration, primaryModel);
        let body = outcome.body;

        if (
            outcome.status === 200 &&
            (operation === 'comm_cover_letter' || operation === 'comm_email')
        ) {
            const meta = parseSaveMeta(req.body as Record<string, unknown>);
            body = await attachCommunicationHistory(
                userId,
                operation,
                parsed.data.input,
                outcome.body,
                'web',
                meta
            );
        }

        if (outcome.status === 200 && outcome.aiMeta) {
            scheduleAiCallLog(
                userId,
                operation,
                'product-site',
                '/api/ai/generate',
                operation,
                outcome.aiMeta
            );
        }

        if (outcome.status === 200 && usageNudge) {
            const { enqueueFreeUsagePair } = await import('../email/campaigns');
            void enqueueFreeUsagePair(userId, usageNudge).catch((err) =>
                console.warn('[email] free usage nudge enqueue failed:', err)
            );
        }

        res.status(outcome.status).json(body);
    } catch (error) {
        if (commReserved) {
            try {
                await refundCommGeneration(userId);
            } catch (refundErr) {
                console.error('[billing] Failed to refund comm usage:', refundErr);
            }
        }
        console.error('Internal Server Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

export async function handleExtensionCoverLetter(req: Request, res: Response): Promise<void> {
    const userId = (req as Request & { user: { uid: string } }).user.uid;
    const { input } = req.body as Record<string, unknown>;

    if (input === undefined || input === null) {
        res.status(400).json({ error: 'INVALID_INPUT', message: 'Missing input object' });
        return;
    }

    const parsed = commCoverLetterInputSchema.safeParse(input);
    if (!parsed.success) {
        res.status(400).json({
            error: 'INVALID_INPUT',
            message: 'Invalid cover letter input',
            details: parsed.error.flatten(),
        });
        return;
    }

    const operation = resolveAiOperation({ operation: 'comm_cover_letter' })!;
    const request = buildSecureGeminiRequest({ operation: 'comm_cover_letter', input: parsed.data });

    let extReserved = false;

    if (isBillingEnabled()) {
        const reserve = await reserveExtensionCoverLetter(userId);
        if (!reserve.ok) {
            res.status(402).json({
                error: reserve.reason,
                message: reserve.message,
                used: reserve.used,
                limit: reserve.limit,
                remaining: reserve.remaining,
            });
            return;
        }
        extReserved = !reserve.isPremium;
    }

    try {
        const outcome = await executeGeneration(userId, operation, request, extReserved, refundExtensionCoverLetter);
        let body = outcome.body;

        if (outcome.status === 200) {
            const meta = parseSaveMeta(req.body as Record<string, unknown>);
            body = await attachCommunicationHistory(
                userId,
                'comm_cover_letter',
                parsed.data,
                outcome.body,
                'extension',
                meta
            );
        }

        if (outcome.status === 200 && outcome.aiMeta) {
            scheduleAiCallLog(
                userId,
                'extension_cover_letter',
                'extension',
                '/api/extension/cover-letter',
                'comm_cover_letter',
                outcome.aiMeta
            );
        }

        res.status(outcome.status).json(body);
    } catch (error) {
        if (extReserved) {
            try {
                await refundExtensionCoverLetter(userId);
            } catch (refundErr) {
                console.error('[billing] Failed to refund ext cover letter usage:', refundErr);
            }
        }
        console.error('Internal Server Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

/**
 * LinkedIn profile optimizer for the Chrome extension.
 * Restricted to Full Premium (monthly/quarterly) subscribers — see isFullPremiumActive.
 */
export async function handleExtensionLinkedinOptimizer(req: Request, res: Response): Promise<void> {
    const userId = (req as Request & { user: { uid: string } }).user.uid;
    const { input } = req.body as Record<string, unknown>;

    if (input === undefined || input === null) {
        res.status(400).json({ error: 'INVALID_INPUT', message: 'Missing input object' });
        return;
    }

    const parsed = linkedinOptimizerInputSchema.safeParse(input);
    if (!parsed.success) {
        res.status(400).json({
            error: 'INVALID_INPUT',
            message: 'Invalid linkedin_optimizer input',
            details: parsed.error.flatten(),
        });
        return;
    }

    if (isBillingEnabled()) {
        const subscription = await refreshSubscriptionIfExpired(userId);
        if (!isFullPremiumActive(subscription)) {
            res.status(402).json({
                error: 'PREMIUM_REQUIRED',
                message: 'LinkedIn Optimiser is a Premium feature. Upgrade to Monthly or Quarterly Premium to unlock.',
                plan: subscription.plan,
            });
            return;
        }
    }

    const hash = computeInputHash(parsed.data);

    try {
        await saveScrapedProfile(userId, parsed.data, hash);
    } catch (error) {
        // Persisting the scrape is best-effort — don't block optimisation on a Firestore hiccup.
        console.error('[linkedinProfile] Failed to save scraped profile:', error);
    }

    try {
        const stored = await getStoredLinkedinProfile(userId);
        if (stored?.optimizationHash === hash && stored.optimizationText) {
            res.status(200).json({ ...(wrapAsGeminiResponse(stored.optimizationText) as object), cached: true });
            return;
        }
    } catch (error) {
        // Cache lookup failing shouldn't block a fresh AI call.
        console.error('[linkedinProfile] Failed to read cached optimisation:', error);
    }

    const request = buildSecureGeminiRequest({ operation: 'linkedin_optimizer', input: parsed.data });

    try {
        const result = await executeAiGeneration('linkedin_optimizer', request);

        if (!result.ok) {
            if (result.status === 500 && result.errorText === 'Server configuration error') {
                console.error('Missing GEMINI_API_KEY environment variable');
                res.status(500).json({ error: 'Server configuration error' });
                return;
            }

            console.error(`AI generation failed (${result.status}):`, result.errorText);

            if (result.status === 429) {
                res.status(429).json({ error: 'Too Many Requests', details: result.errorText });
                return;
            }

            res.status(result.status >= 400 && result.status < 600 ? result.status : 502).json({
                error: 'AI generation failed',
                details: result.errorText,
            });
            return;
        }

        const text = (result.body as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
            ?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        if (text) {
            try {
                await saveOptimizationResult(userId, hash, text);
            } catch (error) {
                console.error('[linkedinProfile] Failed to save optimisation result:', error);
            }
        }

        res.status(200).json({ ...(result.body as object), cached: false });
    } catch (error) {
        console.error('Internal Server Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

/**
 * Persists a raw LinkedIn scrape to Firestore, independent of AI optimisation.
 * Called on every scan from the extension — free for all users (no premium gate).
 */
export async function handleExtensionLinkedinScan(req: Request, res: Response): Promise<void> {
    const userId = (req as Request & { user: { uid: string } }).user.uid;
    const { input } = req.body as Record<string, unknown>;

    if (input === undefined || input === null) {
        res.status(400).json({ error: 'INVALID_INPUT', message: 'Missing input object' });
        return;
    }

    const parsed = linkedinOptimizerInputSchema.safeParse(input);
    if (!parsed.success) {
        res.status(400).json({
            error: 'INVALID_INPUT',
            message: 'Invalid linkedin_optimizer input',
            details: parsed.error.flatten(),
        });
        return;
    }

    try {
        const hash = computeInputHash(parsed.data);
        await saveScrapedProfile(userId, parsed.data, hash);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('[linkedinProfile] Failed to save scraped profile:', error);
        res.status(500).json({ error: 'SAVE_FAILED', message: 'Could not save scraped profile' });
    }
}

/**
 * Returns the most recently scraped profile + AI suggestions for the Chrome extension,
 * so the LinkedIn Optimiser tab can restore what the user last scanned/optimised when
 * they reopen the extension, instead of starting blank until the next scan. Free for
 * all users (same as the scan save) — this only reads back what's already stored, it
 * doesn't generate anything new.
 */
export async function handleExtensionGetLinkedinProfile(req: Request, res: Response): Promise<void> {
    const userId = (req as Request & { user: { uid: string } }).user.uid;

    try {
        const stored = await getStoredLinkedinProfile(userId);

        res.status(200).json({
            success: true,
            scrapedData: stored?.scrapedData ?? null,
            lastScrapedAt: stored?.lastScrapedAt ? stored.lastScrapedAt.toDate().toISOString() : null,
            optimization: stored?.optimizationText ? wrapAsGeminiResponse(stored.optimizationText) : null,
            lastOptimizedAt: stored?.lastOptimizedAt ? stored.lastOptimizedAt.toDate().toISOString() : null,
        });
    } catch (error) {
        console.error('[linkedinProfile] Failed to fetch stored profile:', error);
        res.status(500).json({ error: 'FETCH_FAILED', message: 'Could not load your saved LinkedIn data' });
    }
}
