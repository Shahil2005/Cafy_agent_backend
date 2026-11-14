import type { ChatSearch } from './chatIntent';
import type { ChatGroundedWeb } from './chatGoogleDiscovery';
import type { JobsPortalJob } from './types';

/** Evidence is a literal, bounded excerpt from the supplied CV, never an invented credential. */
export interface CareerProfile {
    skills: Array<{ name: string; evidence: string }>;
    roles: Array<{ title: string; evidence: string }>;
    summary?: string;
    experiences?: Array<{ label: string; evidence: string }>;
    projects?: Array<{ label: string; evidence: string }>;
    education?: Array<{ label: string; evidence: string }>;
    certifications?: Array<{ label: string; evidence: string }>;
    /** Suggested occupations supported by CV facts, never a claim of past employment. */
    searchDirections?: Array<{ title: string; evidence: string[]; skills: string[] }>;
    /** Career stage read from the whole CV; context for scoring and Google only, never a hard filter. */
    level?: CareerLevel;
    /** Job titles this person could realistically apply for now, including equivalent names employers use. */
    targetTitles?: string[];
}

export const CAREER_LEVELS = ['student', 'graduate', 'early-career', 'experienced'] as const;
export type CareerLevel = (typeof CAREER_LEVELS)[number];

/**
 * Holistic judgement of the whole profile against the whole advert: the AI rates
 * role, level, skills and field; the server turns those ratings into the score.
 * Not a hiring probability or eligibility verdict.
 */
export interface CareerFit {
    score: number;
    band: 'strong' | 'good' | 'fair';
    /** One short positive sentence grounded in a verified CV label; absent when it cannot be checked. */
    highlight?: string;
}

export interface CareerMatchJob {
    job: JobsPortalJob;
    reasons: string[];
    matchedSkills: string[];
    evidence: Array<{ skill: string; resumeEvidence: string; jobEvidence: string }>;
    requirementsToCheck: string[];
    fit?: CareerFit;
}

export interface RankedCareerJob extends CareerMatchJob {
    /** Internal ordering only. Not a probability, ATS score or suitability percentage. */
    score: number;
}

export interface CareerMatchCoverage {
    catalogueScanned: number;
    candidates: number;
    limitReached: boolean;
    sourceFailures: number;
    catalogueStatus?: 'checked' | 'unavailable';
    web?: {
        examined: number;
        candidates: number;
        sourcesChecked: number;
        sourcesFailed: number;
        sourcesAvailable: number;
        limitReached: boolean;
    };
}

/** One bounded Google round per CV search; never ranked against the CV or stored in a cursor. */
export type CareerWebDiscoveryStatus = 'searched' | 'unavailable' | 'skipped';
/** Whether this page's jobs carry fit scores: all, some, or none because scoring failed. */
export type CareerFitStatus = 'scored' | 'partial' | 'unavailable';

export const CAREER_MATCH_STATES = ['needs-role', 'needs-clarification', 'results', 'no-matches', 'exhausted', 'unavailable'] as const;
export type CareerMatchState = (typeof CAREER_MATCH_STATES)[number];

export interface CareerMatchResponse {
    state: CareerMatchState;
    /** Route the original question to career guidance without forwarding CV context. */
    conversationAction?: 'advice';
    /** Short-lived encrypted verified profile, retained in session memory only. */
    contextCursor: string;
    profile: CareerProfile;
    search: ChatSearch;
    jobs: CareerMatchJob[];
    nextCursor?: string;
    pageId: string;
    batchSize: 5;
    hasMore: boolean;
    coverage: CareerMatchCoverage;
    message: string;
    /** Transient, attributed Google adverts for this response only. No save, tracker, CV or cursor use. */
    groundedWeb?: ChatGroundedWeb;
    groundedWebStatus?: CareerWebDiscoveryStatus;
    /** Absent when fit scoring is not configured or the page has no jobs. */
    fitStatus?: CareerFitStatus;
}
