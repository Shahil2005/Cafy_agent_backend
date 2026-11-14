import { Request, Response } from 'express';
import * as admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { executeAiGeneration } from '../orchestrator';
import { downloadFile } from '../../storageService';
import { extractPdfText, isPdfUnreadableError } from './parser';
import { careerAnalysisInputSchema, CareerRecommendation, SocOccupationData } from './schema';
import { buildCareerAnalysisRequest } from './prompt';
import { reserveCareerAnalysis, refundCareerAnalysis, type CareerAnalysisTier } from '../../billing/careerAnalysisEntitlements';
import { isBillingEnabled } from '../../billing/config';
import { normalizeAiProvider, recordAiCallForUser } from '../../billing/aiCallTracking';
import { isCareerAnalysisLocationBlocked } from './locationGate';
import { isLowConfidenceMatchError } from './vectorSearch';

const SPONSORSHIP_EMPLOYABILITY_TIERS = ['good', 'fair', 'low'] as const;

/** The prompt asks for 10. Anything at or below this means the generation was truncated or
 *  the fallback model ignored the instruction - reject rather than ship a stub report. */
const MIN_USABLE_RECOMMENDATIONS = (() => {
    const raw = parseInt(process.env.CAREER_MIN_RECOMMENDATIONS || '', 10);
    return Number.isFinite(raw) && raw >= 1 ? raw : 5;
})();

// Mirrors the old `employabilityScore || 0` fail-safe: if the AI omits or mangles this
// field, fall back to the most conservative tier rather than guessing upward.
function normalizeSponsorshipEmployability(value: unknown): 'good' | 'fair' | 'low' {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if ((SPONSORSHIP_EMPLOYABILITY_TIERS as readonly string[]).includes(normalized)) {
        return normalized as 'good' | 'fair' | 'low';
    }
    console.warn(`[career-analysis] AI returned invalid sponsorshipEmployability, defaulting to "low": ${JSON.stringify(value)}`);
    return 'low';
}

function cleanJsonText(text: string): string {
    let clean = text.trim();
    // Remove markdown code blocks if the model outputs them
    if (clean.startsWith('```')) {
        clean = clean.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '').trim();
    }
    return clean;
}

interface SocMasterEntry {
    title: string;
    category: string;
    socData: SocOccupationData;
}

let cachedSocMasterByCode: Record<string, SocMasterEntry> | null = null;

// Real UK government occupation data (title, category, salary, sponsorship), keyed by
// SOC code - looked up here (plain lookup, no AI call) after the AI has already picked
// which codes fit the resume, so the AI never has to reproduce this data itself.
function getSocMasterByCode(): Record<string, SocMasterEntry> {
    if (cachedSocMasterByCode) return cachedSocMasterByCode;

    const datasetPath = path.join(__dirname, '..', '..', 'data', 'uk_soc_master.json');
    const raw = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

    cachedSocMasterByCode = {};
    for (const occ of raw.occupations) {
        cachedSocMasterByCode[occ.code] = {
            title: occ.title,
            category: occ.category,
            socData: {
                skillLevel: occ.skillLevel,
                // Not read from the dataset — the "Related job titles" feature is disabled.
                expandedJobTitles: null,
                sponsorship: occ.sponsorship,
                salary: occ.salary
            }
        };
    }
    return cachedSocMasterByCode;
}

/**
 * Pull the SOC unit-group code out of whatever the model wrote. UK SOC 2020 codes are always
 * 4 digits (1111-9269), so match 4-digit tokens: a bare `/\d+/` grabs the "2020" out of
 * strings like "SOC 2020: 2139" and silently turns a good recommendation into a dropped one.
 *
 * Candidates are ranked rather than taken positionally, because the classification year can
 * appear before OR after the code depending on how the model phrases it:
 *   1. a code that is in the shortlist we gave the model  (strongest signal)
 *   2. otherwise the LAST code that exists in the SOC master - the real code normally follows
 *      the "SOC 2020"-style prefix, and no year in 1990-2030 is a valid SOC code, so this
 *      rejects any year prefix without hard-coding "2020".
 */
function extractSocCode(
    raw: unknown,
    shortlistCodes: Set<string>,
    masterCodes: Set<string>
): string | undefined {
    const candidates = String(raw ?? '').match(/\d{4}/g);
    if (!candidates || candidates.length === 0) return undefined;

    const inShortlist = candidates.find((c) => shortlistCodes.has(c));
    if (inShortlist) return inShortlist;

    for (let i = candidates.length - 1; i >= 0; i--) {
        if (masterCodes.has(candidates[i])) return candidates[i];
    }
    return undefined;
}

interface EnrichmentOutcome {
    recommendations: CareerRecommendation[];
    returnedByAi: number;
    dropped: string[];
}

// The AI only returns a socCode; normalize it defensively (the model can add stray
// whitespace or wrap it in text) and drop any recommendation that doesn't resolve to a
// real SOC code, rather than shipping a record with missing title/category/salary data.
function enrichWithSocData(
    recommendations: CareerRecommendation[],
    shortlistCodes: Set<string>
): EnrichmentOutcome {
    const socMasterByCode = getSocMasterByCode();
    const masterCodes = new Set(Object.keys(socMasterByCode));
    const enriched: CareerRecommendation[] = [];
    const dropped: string[] = [];
    const seen = new Set<string>();

    for (const rec of recommendations) {
        const normalizedCode = extractSocCode(rec.socCode, shortlistCodes, masterCodes);
        const masterEntry = normalizedCode ? socMasterByCode[normalizedCode] : undefined;

        if (!masterEntry) {
            dropped.push(String(rec.socCode ?? '(missing)'));
            continue;
        }
        // A model that repeats the same code would otherwise produce duplicate report pages.
        if (seen.has(normalizedCode!)) {
            dropped.push(`${normalizedCode} (duplicate)`);
            continue;
        }
        seen.add(normalizedCode!);

        enriched.push({
            ...rec,
            socCode: normalizedCode!,
            officialTitle: masterEntry.title,
            category: masterEntry.category,
            socData: masterEntry.socData
        });
    }

    if (dropped.length > 0) {
        console.warn(
            `[career-analysis] Dropped ${dropped.length}/${recommendations.length} recommendations with unusable SOC codes: ${dropped.join(', ')}`
        );
    }

    return { recommendations: enriched, returnedByAi: recommendations.length, dropped };
}

export async function handleCareerAnalysis(req: Request, res: Response): Promise<void> {
    let userId: string | undefined;
    // Set once a slot is successfully reserved — every failure path from that point on must
    // refund it, so a failed analysis never costs the user their free/daily allowance.
    let reservedTier: CareerAnalysisTier | null = null;

    try {
        const authedUser = (req as Request & { user: { uid: string; email?: string } }).user;
        userId = authedUser?.uid;
        const userEmail = authedUser?.email;
        if (!userId) {
            res.status(401).json({ error: 'UNAUTHORIZED', message: 'User must be authenticated.' });
            return;
        }

        const parsed = careerAnalysisInputSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({
                error: 'INVALID_INPUT',
                message: 'Invalid input parameters for career analysis.',
                details: parsed.error.flatten(),
            });
            return;
        }

        const { resumeText, filePath, resumeName: clientResumeName, preferences, skipSave: skipSaveRequested } = parsed.data;
        // Never trust client skipSave in production unless explicitly enabled for ops/testing.
        const skipSave =
            skipSaveRequested === true && process.env.CAREER_ANALYSIS_ALLOW_SKIP_SAVE === 'true';

        // 1. Get raw text from buffer (PDF) or rawText (DOCX parsed in frontend)
        let text = '';
        let resumeName = clientResumeName || 'Career Analysis';

        if (filePath) {
            try {
                // Strip Supabase uri prefix if present (e.g. "supabase:ProductResumes/")
                let cleanPath = filePath;
                const prefix = 'supabase:ProductResumes/';
                if (cleanPath.startsWith(prefix)) {
                    cleanPath = cleanPath.substring(prefix.length);
                }

                resumeName = path.basename(cleanPath);

                // Security check: ensure path belongs to this user
                if (!cleanPath.startsWith(`${userId}/`)) {
                    res.status(403).json({ error: 'ACCESS_DENIED', message: 'Access denied: You can only parse your own files.' });
                    return;
                }

                console.log(`[career-analysis] Downloading file from Supabase: ${cleanPath}`);
                const fileBuffer = await downloadFile(cleanPath);

                console.log(`[career-analysis] Parsing PDF buffer server-side...`);
                text = await extractPdfText(fileBuffer);
            } catch (err) {
                if (isPdfUnreadableError(err)) {
                    console.warn('[career-analysis] Unreadable PDF:', err.reason);
                    res.status(422).json({
                        error: 'PDF_UNREADABLE',
                        message: err.message,
                        reason: err.reason,
                    });
                    return;
                }
                console.error('[career-analysis] File download or parsing failed:', err);
                res.status(500).json({
                    error: 'PARSING_FAILED',
                    message: 'Failed to download or parse the PDF resume.',
                });
                return;
            }
        } else if (resumeText) {
            text = resumeText;
        }

        if (!text || text.trim().length < 50) {
            res.status(400).json({ error: 'EMPTY_RESUME', message: 'The extracted resume text is too short or empty.' });
            return;
        }

        // 1a. Career Path only covers UK SOC codes/sponsorship data — block before spending a
        // billing slot or any AI cost. Checked server-side against the user's own stored
        // preference, never the client-sent `preferences` field on this request.
        if (await isCareerAnalysisLocationBlocked(userId)) {
            res.status(403).json({
                error: 'LOCATION_NOT_SUPPORTED',
                message: 'Career Path is currently only available for UK-based job seekers. Update your location preference in your profile if this is incorrect.',
            });
            return;
        }

        // 1b. Reserve a usage slot BEFORE the expensive SOC matching + AI call. Free/Jobs Premium
        // draw from a lifetime cap; Full Premium (monthly/quarterly) from a per-day cap. Every
        // failure path below this point refunds the reservation on the way out.
        if (isBillingEnabled()) {
            const reserve = await reserveCareerAnalysis(userId, userEmail);
            if (!reserve.ok) {
                res.status(402).json({
                    error: reserve.reason,
                    message: reserve.message,
                    tier: reserve.tier,
                    used: reserve.used,
                    limit: reserve.limit,
                    remaining: reserve.remaining,
                    resetAt: reserve.resetAt,
                });
                return;
            }
            reservedTier = reserve.tier;
        }

        // 2. Build prompts from the top-K vector-matched SOC shortlist
        let systemInstruction: string;
        let userQuery: string;
        let shortlistCodes: Set<string>;
        try {
            ({ systemInstruction, userQuery, shortlistCodes } = await buildCareerAnalysisRequest(text, preferences));
        } catch (err) {
            if (reservedTier) await refundCareerAnalysis(userId, reservedTier);
            // Resume matched, but with no real confidence - don't ship a fabricated report.
            if (isLowConfidenceMatchError(err)) {
                console.warn('[career-analysis] Low-confidence SOC match, top similarity:', err.topSimilarity);
                res.status(422).json({ error: 'LOW_CONFIDENCE_MATCH', message: err.message });
                return;
            }
            console.error('[career-analysis] SOC vector matching failed:', err);
            res.status(502).json({ error: 'AI_MATCHING_UNAVAILABLE', message: 'Failed to match resume against SOC occupations.' });
            return;
        }
        const requestPayload = {
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ parts: [{ text: userQuery }] }]
        };

        console.log(`[career-analysis] Triggering Gemini career match analysis for user: ${userId}`);
        
        // 3. Call AI orchestration (registered as career_path_analysis)
        const result = await executeAiGeneration('career_path_analysis' as any, requestPayload);

        if (!result.ok) {
            console.error('[career-analysis] Gemini request failed:', result.errorText);
            if (reservedTier) await refundCareerAnalysis(userId, reservedTier);
            res.status(502).json({ error: 'AI_GENERATION_FAILED', message: result.errorText });
            return;
        }

        const responseText = (result.body as any)?.candidates?.[0]?.content?.parts?.[0]?.text;

        // Without these two fields a short report is undiagnosable: "MAX_TOKENS" means the
        // generation was cut off (raise maxOutputTokens), while "STOP" with a low
        // candidatesTokenCount means the model simply ignored the Top-10 instruction - a
        // prompt/thinking-budget problem. Previously both looked identical in the logs.
        const diag = (result as any)?.diagnostics;
        console.log('[career-analysis] Generation stats', {
            finishReason: diag?.finishReason,
            promptTokens: diag?.promptTokens,
            outputTokens: diag?.outputTokens,
            thoughtsTokens: diag?.thoughtsTokens,
            truncated: diag?.finishReason === 'MAX_TOKENS',
        });
        console.log('[career-analysis] Raw AI response:', responseText);
        if (!responseText) {
            if (reservedTier) await refundCareerAnalysis(userId, reservedTier);
            res.status(502).json({ error: 'AI_EMPTY_RESPONSE', message: 'Gemini returned empty career paths.' });
            return;
        }

        // 4. Parse response JSON
        let parsedResult: { sponsorshipEmployability: unknown; employabilityFeedback: string; recommendations: CareerRecommendation[] };
        try {
            const cleanJson = cleanJsonText(responseText);
            parsedResult = JSON.parse(cleanJson);
        } catch (parseErr) {
            console.error('[career-analysis] Failed to parse JSON response from Gemini:', responseText);
            if (reservedTier) await refundCareerAnalysis(userId, reservedTier);
            res.status(502).json({ error: 'AI_INVALID_FORMAT', message: 'Failed to parse career recommendations format.' });
            return;
        }

        // 5. Attach real UK government salary/sponsorship data for each AI-picked SOC code
        const enrichment = enrichWithSocData(parsedResult.recommendations || [], shortlistCodes);
        const enrichedRecommendations = enrichment.recommendations;

        // Which model actually served this matters: the orchestrator falls back from
        // gemini-2.5-flash to flash-lite when the primary is slow or the chain budget
        // (AI_CHAIN_MAX_DURATION_MS, 35s default) runs out — and the weaker fallback is the
        // usual reason production returns a handful of recommendations where local returns 10.
        console.log('[career-analysis] Recommendation yield', {
            model: result.model,
            provider: result.provider,
            attempts: result.attempts,
            fallbackUsed: result.attempts > 1,
            returnedByAi: enrichment.returnedByAi,
            usable: enrichedRecommendations.length,
            droppedCodes: enrichment.dropped.length,
        });

        // A 2-page "career report" is worse than no report: it looks authoritative while
        // silently hiding that the generation was truncated or the fallback model ignored
        // the Top-10 instruction. Refund and ask for a retry rather than persisting it.
        if (enrichedRecommendations.length < MIN_USABLE_RECOMMENDATIONS) {
            console.error(
                `[career-analysis] Only ${enrichedRecommendations.length} usable recommendations (AI returned ${enrichment.returnedByAi}, model ${result.model}) — rejecting incomplete analysis.`
            );
            if (reservedTier) await refundCareerAnalysis(userId, reservedTier);
            res.status(502).json({
                error: 'INCOMPLETE_ANALYSIS',
                message: 'The analysis came back incomplete. Please try again in a moment.',
            });
            return;
        }

        // 6. Save to Firestore — one full history doc + one lightweight index doc (same ID),
        // instead of overwriting a single "latest" doc, so past analyses are preserved as history.
        const db = admin.firestore();
        const analysisData = {
            userId,
            uploadedAt: new Date().toISOString(),
            resumeName,
            resumeText: text,
            sponsorshipEmployability: normalizeSponsorshipEmployability(parsedResult.sponsorshipEmployability),
            employabilityFeedback: parsedResult.employabilityFeedback || '',
            recommendations: enrichedRecommendations,
        };

        if (!skipSave) {
            console.log(`[career-analysis] Writing analysis results to Firestore for user: ${userId}`);
            const historyRef = db.collection(`users/${userId}/careerAnalysisHistory`).doc();
            const indexRef = db.doc(`users/${userId}/careerAnalysisHistoryIndex/${historyRef.id}`);
            const indexData = {
                uploadedAt: analysisData.uploadedAt,
                resumeName: analysisData.resumeName,
                sponsorshipEmployability: analysisData.sponsorshipEmployability,
            };
            const batch = db.batch();
            batch.set(historyRef, analysisData);
            batch.set(indexRef, indexData);
            await batch.commit();
        } else {
            console.log(`[career-analysis] Skip saving to Firestore as requested (testing mode).`);
        }

        // 7. Log this call for per-user usage reporting (separate from the reserve/refund limit
        // counters above — this is a running historical total, never resets, never blocks anything).
        // Fire-and-forget: recordAiCallForUser already swallows its own errors internally.
        const aiProvider = normalizeAiProvider(result.provider);
        if (aiProvider) {
            void recordAiCallForUser(userId, {
                category: 'career_path_analysis',
                source: 'product-site',
                route: '/api/ai/career-analysis',
                operation: 'career_path_analysis',
                aiProvider,
                model: result.model,
                status: 'success',
                latencyMs: result.latencyMs,
                attempts: result.attempts,
                fallbackUsed: result.attempts > 1,
            });
        }

        res.status(200).json(analysisData);
    } catch (error) {
        console.error('[career-analysis] Unexpected error:', error);
        // Covers any failure after reservation not already refunded above (e.g. the Firestore
        // write itself throwing) — a slot is never left charged for a request that didn't succeed.
        if (reservedTier && userId) await refundCareerAnalysis(userId, reservedTier);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'An unexpected server error occurred.' });
    }
}
