import type { Request, Response } from 'express';
import type { executeAiGeneration } from '../ai/orchestrator';
import { getJobsPortalRedis } from '../jobs-portal/redisClient';
import { cvTailorBuildRequestSchema, cvTailorQuestionsRequestSchema, type CvTailorBuildResponse, type CvTailorQuestionsResponse } from './contract';
import { hasAgentAccess } from './handler';
import { consumeDaily } from './limits';
import { tailorBuild, tailorQuestions, type TailorFailure } from './tailor';
import { logAgentUsage, recordDailyUsage, type AgentAiCall, type UsageStore } from './usage';

/**
 * POST /api/agent/cv-tailor/questions and /build. Stateless: the CV, the job description and the
 * answers come with each request and nothing is stored. Same plan check and daily limits as the chat.
 */

export interface TailorHandlerDeps {
    generate?: typeof executeAiGeneration;
    hasAccess?: (uid: string) => Promise<boolean>;
    consume?: typeof consumeDaily;
    /** Daily totals store; null turns totals off (tests). */
    usageStore?: UsageStore | null;
}

/** Under Vercel's 60 s function cap. */
const REQUEST_DEADLINE_MS = 56_000;

const FAILURES: Record<TailorFailure['reason'], { status: number; error: string; message: string }> = {
    not_cv: { status: 422, error: 'NOT_CV', message: "That doesn't look like a CV. Please choose a CV from your profile or paste your CV text." },
    not_job: { status: 422, error: 'NOT_JOB_DESCRIPTION', message: "That doesn't look like a job description. Please paste the full job advert." },
    unavailable: { status: 502, error: 'AI_UNAVAILABLE', message: 'CAFY could not finish that right now. Please try again.' },
    bad_output: { status: 502, error: 'AI_UNAVAILABLE', message: 'CAFY could not finish that right now. Please try again.' },
    nothing_left: { status: 502, error: 'AI_UNAVAILABLE', message: 'CAFY could not write a CV it could check against yours. Please try again.' },
};

function userId(req: Request): string | undefined {
    return (req as Request & { user?: { uid?: string } }).user?.uid;
}

export function createCvTailorHandlers(deps: TailorHandlerDeps = {}) {
    const consume = deps.consume ?? consumeDaily;

    /** Shared checks and accounting; `work` runs the AI step and returns the response body. */
    async function serve<T>(
        req: Request,
        res: Response,
        kind: 'questions' | 'build',
        parse: (body: unknown) => { success: true; data: T } | { success: false },
        work: (data: T, signal: AbortSignal) => Promise<({ ok: true; body: unknown } | TailorFailure) & { calls: AgentAiCall[] }>,
    ): Promise<void> {
        res.setHeader('Cache-Control', 'no-store');
        const uid = userId(req);
        if (!uid) {
            res.status(401).json({ error: 'UNAUTHORIZED', message: 'Please sign in to use CAFY.' });
            return;
        }
        const input = parse(req.body);
        if (!input.success) {
            res.status(400).json({ error: 'INVALID_INPUT', message: 'Please add your CV and paste the full job description (at least a few lines).' });
            return;
        }
        try {
            if (!(await (deps.hasAccess ?? hasAgentAccess)(uid))) {
                res.status(403).json({ error: 'PLAN_REQUIRED', message: 'Chat with CAFY is part of the jobs premium plan.' });
                return;
            }
        } catch {
            res.status(503).json({ error: 'INTERNAL', message: 'We could not check your plan. Please try again.' });
            return;
        }
        const allowed = await consume(uid, 'turns').catch(() => ({ allowed: true }));
        if (!allowed.allowed) {
            res.status(429).json({ error: 'LIMIT_REACHED', message: "You have reached today's chat limit. It resets at midnight UK time." });
            return;
        }

        const caller = new AbortController();
        const timer = setTimeout(() => caller.abort(), REQUEST_DEADLINE_MS);
        const disconnect = () => {
            if (!res.writableEnded) caller.abort();
        };
        if (typeof res.once === 'function') res.once('close', disconnect);
        let calls: AgentAiCall[] = [];
        let outcome = `tailor_${kind}:failed`;
        try {
            const result = await work(input.data, caller.signal);
            calls = result.calls;
            if (caller.signal.aborted && !res.writableEnded && !result.ok) {
                outcome = `tailor_${kind}:timeout`;
                res.status(504).json({ error: 'AI_UNAVAILABLE', message: 'That took longer than expected. Please try again.' });
                return;
            }
            if (!result.ok) {
                const failure = FAILURES[result.reason];
                outcome = `tailor_${kind}:${result.reason}`;
                res.status(failure.status).json({ error: failure.error, message: failure.message });
                return;
            }
            outcome = `tailor_${kind}:answered`;
            res.status(200).json(result.body);
        } catch {
            // Never log the CV, the job or provider errors: they can contain personal data.
            res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong. Please try again.' });
        } finally {
            clearTimeout(timer);
            if (typeof res.removeListener === 'function') res.removeListener('close', disconnect);
            if (calls.length) await consume(uid, 'aiCalls', calls.length).catch(() => undefined);
            logAgentUsage(calls, outcome);
            await recordDailyUsage(calls, outcome, [`cv_tailor_${kind}`], deps.usageStore === undefined ? (getJobsPortalRedis() as UsageStore | null) : deps.usageStore);
        }
    }

    return {
        questions: (req: Request, res: Response) =>
            serve(req, res, 'questions', (body) => cvTailorQuestionsRequestSchema.safeParse(body), async (data, signal) => {
                const result = await tailorQuestions({ cvText: data.cv.text, jobDescription: data.jobDescription }, { generate: deps.generate, signal });
                if (!result.ok) return result;
                const body: CvTailorQuestionsResponse = { job: result.job, questions: result.questions };
                return { ok: true, body, calls: result.calls };
            }),
        build: (req: Request, res: Response) =>
            serve(req, res, 'build', (body) => cvTailorBuildRequestSchema.safeParse(body), async (data, signal) => {
                const result = await tailorBuild({ cvText: data.cv.text, jobDescription: data.jobDescription, answers: data.answers }, { generate: deps.generate, signal });
                if (!result.ok) return result;
                const body: CvTailorBuildResponse = { cv: result.cv, changes: result.changes, removed: result.removed };
                return { ok: true, body, calls: result.calls };
            }),
    };
}

export const cvTailorHandlers = createCvTailorHandlers();
