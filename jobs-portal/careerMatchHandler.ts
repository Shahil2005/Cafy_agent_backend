import type { Request, Response } from 'express';
import * as admin from 'firebase-admin';
import { getUserBillingDoc, isJobsPremiumActive, isPartTimePremiumActive } from '../billing/subscriptionService';
import { isBillingEnabled } from '../billing/config';
import { resolveJobsCatalogCountry } from './jobsCatalog';
import { isPartTimeJobsBlocked, partTimeLocationsFromProfile } from './partTimeAccess';
import { ChatExecutionError, createChatExecution } from './chatExecution';
import { CareerCursorError } from './careerMatchCursor';
import { CareerProfileError, careerTitleInFamily } from './careerMatchProfile';
import { careerMatchInputSchema, CareerMatchError, runCareerMatches, type CareerMatchContext, type CareerMatchDependencies } from './careerMatchService';
import { getGeminiApiKey } from '../ai/config';
import { searchChatGoogleWeb } from './chatGoogleDiscovery';
import { isPermittedCareerResearchAnswer } from './chatPolicy';
import { assessCareerFit } from './careerMatchFit';
import { expandCareerRole } from './careerMatchRoles';

interface HandlerDependencies {
    /** Read-only auth/profile dependency injection for isolated handler tests. */
    context?: (userId: string) => Promise<CareerMatchContext>;
    run?: typeof runCareerMatches;
    timeoutMs?: number;
    /** Defaults to configured Google discovery; tests inject a mock or `null` for none. */
    groundedSearch?: CareerMatchDependencies['groundedSearch'] | null;
    /** Defaults to configured fit scoring; tests inject a mock or `null` for none. */
    assessFit?: CareerMatchDependencies['assessFit'] | null;
    /** Defaults to configured role expansion; tests inject a mock or `null` for none. */
    expandRole?: CareerMatchDependencies['expandRole'] | null;
}

/** Same Google discovery as the source pipeline, minus its usage write (this route records no usage). */
function configuredGroundedSearch(): CareerMatchDependencies['groundedSearch'] {
    if (!getGeminiApiKey('jobs_web_discovery')) return undefined;
    return (search, country, { context, ...options }) => {
        // A card may carry the requested title or any of its validated equivalents.
        const family = [search.role, ...(context?.roleTitles || [])].filter(Boolean);
        return searchChatGoogleWeb(search, country, {
            ...options, maxTotalAttempts: 1, validateAnswer: isPermittedCareerResearchAnswer,
            roleMatches: (title) => careerTitleInFamily(title, family),
            ...(context ? { searchContext: { alternativeTitles: context.roleTitles, level: context.level, skills: context.skills } } : {}),
        });
    };
}

/** Provider-only role widening ("developer" also finds Software Engineer); records no usage. */
function configuredExpandRole(): CareerMatchDependencies['expandRole'] {
    if (!getGeminiApiKey('jobs_cv_roles')) return undefined;
    return (role, profile, options) => expandCareerRole(role, profile, options);
}

/** Provider-only fit judgement; like the CV extraction, this route records no usage. */
function configuredAssessFit(): CareerMatchDependencies['assessFit'] {
    if (!getGeminiApiKey('jobs_cv_fit')) return undefined;
    return (profile, jobs, options) => assessCareerFit(profile, jobs, options);
}

async function readContext(userId: string): Promise<CareerMatchContext> {
    const snapshot = await admin.firestore().doc(`users/${userId}`).get();
    const { subscription, data } = await getUserBillingDoc(userId, snapshot);
    return {
        userId,
        country: resolveJobsCatalogCountry(partTimeLocationsFromProfile(data)),
        careerPremium: isBillingEnabled() && isJobsPremiumActive(subscription),
        partTimePremium: isBillingEnabled() && isPartTimePremiumActive(subscription),
        partTimeBlocked: isPartTimeJobsBlocked(data),
    };
}

/** This route deliberately does not invoke billing reservations, usage writes, CV saves or handoffs. */
export function createCareerMatchHandler(deps: HandlerDependencies = {}) {
    return async (req: Request, res: Response): Promise<void> => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        const uid = (req as Request & { user?: { uid?: string } }).user?.uid;
        if (!uid) { res.status(401).json({ error: 'UNAUTHORIZED', message: 'Please sign in to match your CV.' }); return; }
        const input = careerMatchInputSchema.safeParse(req.body);
        if (!input.success) {
            res.status(400).json({ error: 'INVALID_MATCH_INPUT', message: 'Choose a readable CV with 50 to 40,000 characters, or restart the shortlist if its continuation has expired.' });
            return;
        }
        const caller = new AbortController();
        const disconnect = () => { if (!res.writableEnded) caller.abort(); };
        req.once('aborted', disconnect);
        res.once('close', disconnect);
        const execution = createChatExecution({ signal: caller.signal, timeoutMs: deps.timeoutMs ?? 55_000 });
        try {
            const context = await execution.run(() => (deps.context || readContext)(uid));
            if (context.userId !== uid) throw new Error('Context identity mismatch');
            const groundedSearch = deps.groundedSearch === null ? undefined : deps.groundedSearch ?? configuredGroundedSearch();
            const assessFit = deps.assessFit === null ? undefined : deps.assessFit ?? configuredAssessFit();
            const expandRole = deps.expandRole === null ? undefined : deps.expandRole ?? configuredExpandRole();
            const output = await execution.run(() => (deps.run || runCareerMatches)(input.data, context, {
                signal: execution.signal, ...(groundedSearch ? { groundedSearch } : {}), ...(assessFit ? { assessFit } : {}),
                ...(expandRole ? { expandRole } : {}),
            }));
            if (!caller.signal.aborted && !res.destroyed) res.status(200).json(output);
        } catch (error) {
            if (caller.signal.aborted || res.destroyed) return;
            if (error instanceof CareerCursorError) {
                res.status(409).json({ error: 'SHORTLIST_EXPIRED', message: error.message });
            } else if (error instanceof CareerProfileError) {
                res.status(error.code === 'PROFILE_UNAVAILABLE' ? 503 : 422).json({ error: error.code, message: error.message });
            } else if (error instanceof CareerMatchError) {
                const status = error.code === 'PLAN_REQUIRED' ? 403
                    : ['NOT_CONFIGURED', 'CATALOGUE_UNAVAILABLE', 'CANCELLED'].includes(error.code) ? 503 : 400;
                res.status(status).json({ error: error.code, message: error.message });
            } else if (error instanceof ChatExecutionError) {
                res.status(503).json({ error: 'MATCH_TIMEOUT', message: 'The shortlist took too long to prepare. Your CV was not saved; please try again.' });
            } else {
                // Never log the CV, cursor, raw provider error or database identifiers.
                res.status(503).json({ error: 'MATCH_UNAVAILABLE', message: 'The matching service could not complete this request. Please try again shortly.' });
            }
        } finally {
            req.removeListener('aborted', disconnect);
            res.removeListener('close', disconnect);
            execution.cleanup();
        }
    };
}

export const handleCareerMatches = createCareerMatchHandler();
