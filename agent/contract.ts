import { z } from 'zod';

/**
 * Wire contract for the CAFY chat agent. Mirrored in Product-Site `src/services/agentContract.ts`;
 * keep both in step. The model never returns UI code: it picks from these pieces, the server
 * validates each one and drops anything invalid.
 */

/** Room for a pasted job advert (most are 2,000-6,000 characters) with a question around it. */
export const MAX_MESSAGE_CHARS = 8000;
export const MAX_HISTORY_TURNS = 8;
export const MAX_HISTORY_TURN_CHARS = 1500;

export const agentHistoryTurnSchema = z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(MAX_HISTORY_TURN_CHARS),
});

export const MAX_CV_TEXT_CHARS = 120_000;

export const agentTurnRequestSchema = z.object({
    /** Omitted for a new conversation; the server creates one and returns its id. */
    conversationId: z.string().regex(/^[A-Za-z0-9]{10,40}$/).optional(),
    message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
    /** Regenerate / Try again: replaces the previous answer to the same question instead of adding a duplicate. */
    regenerate: z.boolean().optional(),
    /** A CV the user picked from their own profile, read in the browser. Indexed once per version. */
    cv: z
        .object({
            name: z.string().trim().min(1).max(120),
            text: z.string().trim().min(50).max(MAX_CV_TEXT_CHARS),
            /** The saved resume id (or 'profile'), so the agent's copy is removed when that resume is deleted. */
            sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
        })
        .optional(),
    /** A tailored CV ("/cv") is on the user's screen in this template, so its look can be changed from the chat. */
    tailoredCv: z.object({ template: z.string().regex(/^[a-z-]{2,24}$/) }).optional(),
});

export type AgentTurnRequest = z.infer<typeof agentTurnRequestSchema>;
export type AgentHistoryTurn = z.infer<typeof agentHistoryTurnSchema>;

const line = z.string().trim().min(1).max(600);
const items = z.array(line).min(1).max(8);

/** Building blocks the model may combine into an answer card for any question. */
export const uiPieceSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('heading'), text: z.string().trim().min(1).max(120) }),
    z.object({ type: z.literal('paragraph'), text: z.string().trim().min(1).max(2000) }),
    z.object({ type: z.literal('steps'), items }),
    z.object({ type: z.literal('tips'), items }),
    z.object({
        type: z.literal('doDont'),
        do: z.array(line).max(6).default([]),
        dont: z.array(line).max(6).default([]),
    }),
    z.object({
        type: z.literal('example'),
        title: z.string().trim().max(120).optional(),
        // Long enough for a whole cover letter: a piece over the limit is dropped, not cut.
        text: z.string().trim().min(1).max(6000),
    }),
    z.object({ type: z.literal('warning'), text: z.string().trim().min(1).max(600) }),
    /** Titled cards, e.g. types of roles, options or employers, each with a short description. */
    z.object({
        type: z.literal('list'),
        title: z.string().trim().max(120).optional(),
        items: z
            .array(z.object({ title: z.string().trim().min(1).max(100), text: z.string().trim().max(600).optional() }))
            .min(1)
            .max(10),
    }),
    /** Exact text from the user's CV; the server drops any quote not found in the CV. */
    z.object({ type: z.literal('quote'), text: z.string().trim().min(3).max(400), section: z.string().trim().max(60).optional() }),
    z.object({
        type: z.literal('facts'),
        items: z
            .array(z.object({ label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(200) }))
            .min(1)
            .max(6),
    }),
]);

export type UiPiece = z.infer<typeof uiPieceSchema>;

export interface CvProfileCard {
    name: string;
    headline: string;
    years: number;
    roles: Array<{ title: string; employer?: string; dates?: string }>;
    education: Array<{ qualification: string; institution?: string; dates?: string }>;
    skills: Array<{ name: string; source: string }>;
    projects: string[];
    counts: { roles: number; skills: number; projects: number; achievements: number; certifications: number };
    hasPersonalStatement: boolean;
}

export interface SourceRef {
    label: string;
    url: string;
    /** Human date of the data, e.g. "July 2026". */
    date: string;
}

export interface SocCardsCard {
    options: Array<{
        code: string;
        title: string;
        skillLevel: string | null;
        eligible: boolean | null;
        note: string;
        generalThreshold?: number;
        newEntrantThreshold?: number;
        /** Who can use this code, stated plainly from the official applicant status. */
        newApplicants: string;
        existingHolders: string;
        examples: string[];
        /** Similarity as a percentage. Absent when the code was chosen from the CV: the first is then the best fit. */
        match?: number;
    }>;
    source: SourceRef;
}

export interface OfficialFactsCard {
    title: string;
    facts: Array<{ label: string; value: string; note?: string }>;
    notes: string[];
    source: SourceRef;
    /** For one SOC code: the rest of what the official data says. */
    details?: {
        jobTitles: string[];
        moreJobTitles: number;
        phdEligible?: boolean;
        routes?: string[];
        salaryList?: Array<{ criteria: string; where?: string; until?: string }>;
        payScales?: Array<{ nation: string; text: string }>;
        table?: string;
    };
}

export interface SponsorListCard {
    query: string;
    total: number;
    items: Array<{
        name: string;
        tradingAs?: string;
        town: string;
        county: string;
        rating?: 'A' | 'B';
        routes: string[];
        confidence?: 'exact' | 'close' | 'possible';
    }>;
    /** Several close matches and none exact: the user picks one. */
    didYouMean?: string[];
    route?: string;
    source: SourceRef;
}

export interface JobListCard {
    query: string;
    /** True when the CV chose the jobs; false when the user's request did. */
    fromCv: boolean;
    /** The catalogue has little that is close: the answer says so plainly. */
    fewCloseMatches: boolean;
    /** Recommended jobs, not a list: "job 2" and "more" still refer to the list before it. */
    pick?: boolean;
    /** Shown before the jobs are read against the CV; the same card is sent again, complete, when that is done. */
    checking?: boolean;
    /** The full ranking was too slow, so these jobs were found by job title (and the CV's field and level). */
    byTitle?: boolean;
    /** Kept for follow-ups but not shown, when the user asked for fewer jobs than were read. */
    hidden?: boolean;
    /** A recommendation (top 3, closest match), not one job being discussed: its jobs take the first numbers. */
    shortlist?: boolean;
    /** Jobs already recommended from this list, so "another one" does not offer them again. */
    recommendedIds?: number[];
    /** Settings of this search, so follow-ups like "only remote" can change them. */
    search: Record<string, unknown>;
    /** Every job shown so far in this search, so "more" does not repeat them. */
    shownIds: number[];
    items: Array<{
        id: number;
        title: string;
        company?: string;
        location?: string;
        salary?: string;
        jobType?: string;
        postedAt?: string;
        url?: string;
        /** The employer's licence is confirmed on the official register. Never means this job is sponsored. */
        sponsor: boolean;
        levelNote?: string;
        /** Decided by code from facts; the AI explains it and may not raise it. */
        verdict?: { label: 'close' | 'possible' | 'stretch'; reason: string };
        visa?: {
            goingRate?: number;
            goingRateHourly?: number;
            options: Array<{ option: string; threshold: number; hourly?: number; who: string }>;
            phdEligible?: boolean;
            routes?: string[];
            salaryList?: Array<{ criteria: string; where?: string; until?: string }>;
            payScales?: Array<{ nation: string; text: string }>;
            jobTitles: string[];
            moreJobTitles: number;
            /** CAFY's estimate from the advert; the employer chooses the code. */
            soc: { code: string; title: string; sure: boolean };
            otherSoc: Array<{ code: string; title: string }>;
            outcome: 'eligible' | 'not_sure' | 'not_eligible';
            reasons: string[];
            newApplicants: string;
            existingHolders: string;
            generalThreshold?: number;
            newEntrantThreshold?: number;
            payCheck?: 'meets' | 'below';
            checkedOn?: string;
        };
        summary?: string;
        /** Only skills proven by a quote found in the CV. */
        have: Array<{ skill: string; quote?: string }>;
        missing: string[];
    }>;
}

export interface OfficialSourcesCard {
    items: Array<{ title: string; section: string; url: string; checked: string; updated?: string; stale?: boolean }>;
}

/** Two or three listed jobs side by side. Every value is a stored fact; the verdict is decided by code. */
export interface JobCompareCard {
    jobs: Array<{
        id: number;
        title: string;
        company?: string;
        location?: string;
        salary?: string;
        jobType?: string;
        postedAt?: string;
        url?: string;
        /** The employer holds a licence. Never means this job is sponsored. */
        sponsorLicence: boolean;
        levelNote?: string;
        verdict?: { label: 'close' | 'possible' | 'stretch'; reason: string };
        visa?: { outcome: 'eligible' | 'not_sure' | 'not_eligible'; soc: string; sure: boolean; payCheck?: 'meets' | 'below' };
        have: string[];
        missing: string[];
    }>;
    /** The job whose verdict and evidence are best, when the CV was read against all of them. */
    closestId?: number;
}

/** Skills the CV does not show, counted across the jobs on screen. */
export interface SkillGapCard {
    basedOn: number;
    gaps: Array<{ skill: string; jobs: number }>;
}

export type AgentBlock =
    | { kind: 'answerCard'; pieces: UiPiece[] }
    | { kind: 'cvProfile'; card: CvProfileCard }
    | { kind: 'socCards'; card: SocCardsCard }
    | { kind: 'officialFacts'; card: OfficialFactsCard }
    | { kind: 'sponsorList'; card: SponsorListCard }
    | { kind: 'jobList'; card: JobListCard }
    | { kind: 'officialSources'; card: OfficialSourcesCard }
    | { kind: 'jobCompare'; card: JobCompareCard }
    | { kind: 'skillGaps'; card: SkillGapCard }
    /** Asks the user to choose one of their saved profile CVs. */
    | { kind: 'cvPicker' }
    /** Switches the tailored CV on screen to this template (applied in the browser; no AI writes the CV again). */
    | { kind: 'cvTemplate'; template: string; name: string };

// ---- CV tailoring ("/cv"): stateless, nothing is stored on the server ----

export const MAX_JOB_DESCRIPTION_CHARS = 12_000;
export const MAX_TAILOR_ANSWERS = 8;

const tailorCvSchema = z.object({
    name: z.string().trim().min(1).max(120),
    text: z.string().trim().min(50).max(MAX_CV_TEXT_CHARS),
});
const jobDescriptionSchema = z.string().trim().min(80).max(MAX_JOB_DESCRIPTION_CHARS);

export const cvTailorAnswerSchema = z.object({
    questionId: z.string().trim().min(1).max(20),
    question: z.string().trim().min(1).max(300),
    answer: z.string().trim().min(1).max(600),
    /** The job requirement the question checked, and whether the chosen answer says the person has it. */
    skill: z.string().trim().min(1).max(80).optional(),
    confirmed: z.boolean().optional(),
});

export const cvTailorQuestionsRequestSchema = z.object({ cv: tailorCvSchema, jobDescription: jobDescriptionSchema });
export const cvTailorBuildRequestSchema = z.object({
    cv: tailorCvSchema,
    jobDescription: jobDescriptionSchema,
    answers: z.array(cvTailorAnswerSchema).max(MAX_TAILOR_ANSWERS),
});

export type CvTailorAnswer = z.infer<typeof cvTailorAnswerSchema>;

export interface CvTailorQuestion {
    id: string;
    text: string;
    why?: string;
    /** Set when the question checks one requirement of the job; options then say whether they confirm it. */
    skill?: string;
    options: Array<{ label: string; confirms?: boolean }>;
}

export interface CvTailorQuestionsResponse {
    job: { title: string; company?: string };
    questions: CvTailorQuestion[];
}

/** The tailored CV, without contact details: the browser adds those, so they never reach the AI. */
export interface TailoredCv {
    headline: string;
    summary: string;
    skills: Array<{ group: string; items: string[] }>;
    experience: Array<{ title: string; employer: string; location?: string; dates?: string; bullets: string[] }>;
    education: Array<{ qualification: string; institution?: string; dates?: string; details?: string }>;
    projects: Array<{ name: string; bullets: string[] }>;
    certifications: string[];
    extras: Array<{ heading: string; items: string[] }>;
}

export interface CvTailorBuildResponse {
    cv: TailoredCv;
    /** Short notes on what was changed for this job. */
    changes: string[];
    /** Items removed because the CV and the answers did not support them. */
    removed: number;
}

export const MAX_SUGGESTIONS = 4;
export const suggestionSchema = z.string().trim().min(2).max(80);

/** Server-sent events, in the order a turn normally produces them. */
export type AgentEvent =
    | { type: 'status'; id: string; label: string; state: 'running' | 'done' | 'failed' }
    | { type: 'text'; delta: string }
    | { type: 'block'; id: string; block: AgentBlock }
    | { type: 'suggestions'; items: string[] }
    | { type: 'conversation'; id: string; title: string }
    /** The CV in use changed (name) or is no longer available (null). */
    | { type: 'cv'; name: string | null }
    /** answerIndex: position of this answer among the conversation's saved answers (for feedback). */
    | { type: 'done'; steps: number; answerIndex?: number }
    | { type: 'error'; code: AgentErrorCode; message: string; retryable: boolean };

export type AgentErrorCode =
    | 'INVALID_INPUT'
    | 'CV_UNREADABLE'
    | 'PLAN_REQUIRED'
    | 'LIMIT_REACHED'
    | 'AI_UNAVAILABLE'
    | 'INTERNAL';
