import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createChatExecution, ChatExecutionError } from './chatExecution';
import { chatSearchSchema, type ChatSearch } from './chatIntent';
import { matchChatJob } from './chatMatching';
import { canonicalJobUrl } from './chatWebUrls';
import {
    readChatEmployerBoard,
    searchChatEmployerWebJobs,
    type ChatLiveWebResult,
} from './chatLiveWeb';
import {
    fetchEmployerBoardJobs,
    type EmployerBoard,
} from './chatEmployerSources';
import { searchChatGovernmentJobs } from './chatGovernmentSources';
import type { JobsCatalogCountry } from './jobsCatalog';
import type { JobsPortalJob } from './types';
import { careerTitleInFamily, careerTitleMatches } from './careerMatchProfile';
import { careerRoleRetrievalQuery } from './careerMatchRoleQuery';

const MAX_WEB_CANDIDATES = 60;
const CAREER_MAX_BOARDS = 12;
const MAX_RELOAD_REFERENCES = 20;
const MAX_BOARDS = 6;
const WEB_TIMEOUT_MS = 20_000;
const canonicalUrlSchema = z.string().max(2048).refine((value) => canonicalJobUrl(value) === value);

/** Encrypted continuation metadata; descriptions and complete job records are not retained. */
export const careerWebReferenceSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('employer-board'),
        provider: z.enum(['greenhouse', 'lever', 'ashby']),
        token: z.string().regex(/^[a-zA-Z0-9_-]{1,150}$/),
        region: z.enum(['eu', 'global']),
        companyId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        url: canonicalUrlSchema,
    }).strict(),
    z.object({
        kind: z.literal('government'),
        sourcePath: z.string().regex(/^\/jobs\/[a-f0-9]{24}$/),
        url: canonicalUrlSchema,
    }).strict(),
]);
export type CareerWebReference = z.infer<typeof careerWebReferenceSchema>;

export interface CareerWebCoverage {
    examined: number;
    candidates: number;
    /** Independent adapters attempted, not a claim about every employer in the UK. */
    sourcesChecked: number;
    sourcesFailed: number;
    sourcesAvailable: number;
    limitReached: boolean;
}
export interface CareerWebCollection {
    jobs: JobsPortalJob[];
    references: Record<string, CareerWebReference>;
    coverage: CareerWebCoverage;
}
export interface CareerWebReload {
    jobs: JobsPortalJob[];
    sourceFailures: number;
}
export interface CareerWebDependencies {
    signal?: AbortSignal;
    client?: SupabaseClient;
    now?: () => number;
    /** Bounded test deadline, never extends the production 20-second budget. */
    timeoutMs?: number;
    employerSearch?: typeof searchChatEmployerWebJobs;
    governmentSearch?: typeof searchChatGovernmentJobs;
    fetchBoard?: typeof fetchEmployerBoardJobs;
    readBoard?: typeof readChatEmployerBoard;
    /** Equivalent titles for an explicit role (the role first); reloads keep the same family. */
    roleTitles?: string[];
}

export class CareerWebError extends Error {
    constructor(readonly code: 'INVALID_REFERENCE' | 'UNAVAILABLE') {
        super('The supported employer sources could not be checked.');
        this.name = 'CareerWebError';
    }
}

function assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ChatExecutionError('cancelled');
}
function assertCountry(country: JobsCatalogCountry): void {
    if (country !== 'uk' && country !== 'ireland') throw new CareerWebError('UNAVAILABLE');
}
function timeout(deps: CareerWebDependencies): number {
    return Number.isFinite(deps.timeoutMs) ? Math.max(0, Math.min(WEB_TIMEOUT_MS, deps.timeoutMs!)) : WEB_TIMEOUT_MS;
}
/** The explicit role always leads its family; titles are already validated by the role expander. */
function roleFamily(search: ChatSearch, titles: string[] = []): string[] {
    if (!search.role) return [];
    const family = [search.role, ...titles.map((title) => title.trim()).filter(Boolean)];
    return [...new Map(family.map((title) => [title.toLowerCase(), title])).values()];
}
function usable(job: JobsPortalJob, search: ChatSearch, now: number, family: string[]): boolean {
    const expiry = job.listingSource?.expiresAt;
    const posted = job.listingSource?.postedAt;
    const description = job.description?.slice(0, 20_000).replace(/<[^>]*>/g, ' ').trim() || '';
    return Boolean(
        job.id && job.title.trim() && job.company?.trading_name?.trim() &&
        description.length >= 50 &&
        job.listingSource?.kind === 'web' && job.listingSource.provider === 'employer-sites' &&
        job.listingSource.availability === 'source-listed' && canonicalJobUrl(job.url) &&
        (search.kind !== 'part-time' || job.jobType === 'Part-time') &&
        (!posted || (Number.isFinite(Date.parse(posted)) && Date.parse(posted) <= now)) &&
        (!expiry || (Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) > now)) &&
        (!search.role || careerTitleInFamily(job.title, family)) &&
        matchChatJob(job, { ...search, role: '' }).matches,
    );
}
function boardIdentity(board: Pick<EmployerBoard, 'provider' | 'token' | 'region'>): string {
    return `${board.provider}:${board.region || 'global'}:${board.token}`;
}
function employerReference(board: EmployerBoard, job: JobsPortalJob): CareerWebReference | undefined {
    const parsed = careerWebReferenceSchema.safeParse({
        kind: 'employer-board', provider: board.provider, token: board.token,
        region: board.region || 'global', companyId: board.company?.id, url: canonicalJobUrl(job.url),
    });
    return parsed.success ? parsed.data : undefined;
}
function governmentReference(sourceUrl: string, job: JobsPortalJob): CareerWebReference | undefined {
    let parsedUrl: URL;
    try { parsedUrl = new URL(sourceUrl); } catch { return undefined; }
    if (parsedUrl.origin !== 'https://www.jobs.service.gov.uk' || parsedUrl.search || parsedUrl.hash)
        return undefined;
    const parsed = careerWebReferenceSchema.safeParse({
        kind: 'government', sourcePath: parsedUrl.pathname, url: canonicalJobUrl(job.url),
    });
    return parsed.success ? parsed.data : undefined;
}

/**
 * Independent supported ATS feeds and Work Hub. CV content, Google URLs, shared
 * cache writes and AI requests never enter this module. Sources establish country
 * from their own rendered/structured fields before producing public job records.
 */
export async function collectCareerWebCandidates(
    search: ChatSearch,
    country: JobsCatalogCountry,
    roleQueries: string[],
    deps: CareerWebDependencies = {},
): Promise<CareerWebCollection> {
    const criteria = chatSearchSchema.parse(search);
    assertCountry(country);
    assertActive(deps.signal);
    if (!Array.isArray(roleQueries) || roleQueries.some((value) => typeof value !== 'string' || value.length > 100))
        throw new CareerWebError('UNAVAILABLE');
    const coverage: CareerWebCoverage = {
        examined: 0, candidates: 0, sourcesChecked: 0, sourcesFailed: 0,
        sourcesAvailable: country === 'uk' ? 2 : 1, limitReached: false,
    };
    if (criteria.unsupported.length || (criteria.kind === 'part-time' && country !== 'uk'))
        return { jobs: [], references: {}, coverage };
    const queries = [...new Set(roleQueries.map((role) => role.trim()).filter(Boolean))];
    // For an explicit role the queries are its family of equivalent titles.
    const family = roleFamily(criteria, queries);
    const discoverySearch = { ...criteria, role: careerRoleRetrievalQuery(criteria.role || queries[0] || '') };
    if (!discoverySearch.role && !discoverySearch.employer)
        return { jobs: [], references: {}, coverage };
    coverage.limitReached = !criteria.role && queries.length > 1;
    const execution = createChatExecution({ signal: deps.signal, timeoutMs: timeout(deps) });
    const now = (deps.now || Date.now)();
    const observed: Array<{ job: JobsPortalJob; reference: CareerWebReference; source: number }> = [];
    const capture = (job: JobsPortalJob, reference: CareerWebReference | undefined, source: number) => {
        if (!reference || execution.signal.aborted || !usable(job, criteria, now, family)) return;
        // A whole employer board must not fill the bounded candidate list with unrelated occupations.
        if (!criteria.role && queries.length && !queries.some((query) => careerTitleMatches(job.title, query))) return;
        // The source supplies identities; a callback cannot substitute another URL.
        if (canonicalJobUrl(job.url) !== reference.url) return;
        observed.push({ job, reference, source });
    };
    const requests: Array<() => Promise<ChatLiveWebResult>> = [() =>
        (deps.employerSearch || searchChatEmployerWebJobs)(discoverySearch, country, {
            signal: execution.signal, client: deps.client, now: deps.now, fetchBoard: deps.fetchBoard,
            // Twice the manual chat's boards: more employer career pages per CV search, still one bounded round.
            maxBoards: CAREER_MAX_BOARDS,
            onBoardJobs: (board, jobs) => jobs.forEach((job) => capture(job, employerReference(board, job), 0)),
        }),
    ];
    if (country === 'uk') requests.push(() =>
        (deps.governmentSearch || searchChatGovernmentJobs)(discoverySearch, country, {
            signal: execution.signal, now: deps.now, timeoutMs: execution.remainingMs(),
            onJob: (job, url) => capture(job, governmentReference(url, job), 1),
        }),
    );
    try {
        coverage.sourcesChecked = requests.length;
        const results = await Promise.allSettled(requests.map((request) => execution.run(request)));
        assertActive(deps.signal);
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                coverage.examined += result.value.examined;
                coverage.limitReached ||= result.value.limitReached;
                if (result.value.boardsFailed) coverage.sourcesFailed++;
            } else {
                coverage.sourcesFailed++;
                coverage.limitReached = true;
                // Only completed native adverts are counted if their source later times out.
                coverage.examined += observed.filter((entry) => entry.source === index).length;
            }
        });
        const jobs: JobsPortalJob[] = [];
        const references: Record<string, CareerWebReference> = {};
        const seenIds = new Set<string>();
        const seenUrls = new Set<string>();
        for (const { job, reference } of observed) {
            const url = canonicalJobUrl(job.url)!;
            if (seenIds.has(job.id) || seenUrls.has(url)) continue;
            if (jobs.length >= MAX_WEB_CANDIDATES) { coverage.limitReached = true; continue; }
            seenIds.add(job.id);
            seenUrls.add(url);
            jobs.push(job);
            references[job.id] = reference;
        }
        coverage.candidates = jobs.length;
        return { jobs, references, coverage };
    } finally {
        execution.cleanup();
    }
}

/** Re-fetch only exact independent sources authenticated by the encrypted cursor. */
export async function reloadCareerWebCandidates(
    references: CareerWebReference[],
    search: ChatSearch,
    country: JobsCatalogCountry,
    deps: CareerWebDependencies = {},
): Promise<CareerWebReload> {
    const criteria = chatSearchSchema.parse(search);
    assertCountry(country);
    assertActive(deps.signal);
    const parsed = z.array(careerWebReferenceSchema).max(MAX_RELOAD_REFERENCES).safeParse(references);
    if (!parsed.success) throw new CareerWebError('INVALID_REFERENCE');
    const refs = parsed.data;
    if (new Set(refs.map((value) => value.url)).size !== refs.length)
        throw new CareerWebError('INVALID_REFERENCE');
    if (!refs.length || criteria.unsupported.length || (criteria.kind === 'part-time' && country !== 'uk'))
        return { jobs: [], sourceFailures: 0 };
    if (country !== 'uk' && refs.some((value) => value.kind === 'government'))
        throw new CareerWebError('INVALID_REFERENCE');
    const groups = new Map<string, CareerWebReference[]>();
    for (const reference of refs) {
        const key = reference.kind === 'government'
            ? 'government'
            : `${reference.companyId}:${boardIdentity(reference)}`;
        groups.set(key, [...(groups.get(key) || []), reference]);
    }
    const employerGroups = [...groups.keys()].filter((key) => key !== 'government');
    if (employerGroups.length > MAX_BOARDS) throw new CareerWebError('INVALID_REFERENCE');
    const governmentRefs = groups.get('government') || [];
    if (governmentRefs.length > 10) throw new CareerWebError('INVALID_REFERENCE');
    const execution = createChatExecution({ signal: deps.signal, timeoutMs: timeout(deps) });
    const now = (deps.now || Date.now)();
    const family = roleFamily(criteria, deps.roleTitles);
    const found = new Map<string, JobsPortalJob>();
    let sourceFailures = 0;
    const tasks = [...groups.values()];
    let next = 0;
    try {
        await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, async () => {
            while (next < tasks.length && !execution.signal.aborted) {
                const group = tasks[next++]!;
                const first = group[0]!;
                try {
                    await execution.run(async () => {
                        if (first.kind === 'employer-board') {
                            const board = await (deps.readBoard || readChatEmployerBoard)(first.companyId, country, {
                                signal: execution.signal, client: deps.client,
                            });
                            if (!board || board.company?.id !== first.companyId || boardIdentity(board) !== boardIdentity(first))
                                return;
                            const result = await (deps.fetchBoard || fetchEmployerBoardJobs)(board, country, {
                                signal: execution.signal, now: deps.now, timeoutMs: execution.remainingMs(),
                            });
                            const urls = new Set(group.map((entry) => entry.url));
                            for (const job of result.jobs) {
                                if (execution.signal.aborted) return;
                                const url = canonicalJobUrl(job.url);
                                if (url && urls.has(url) && usable(job, criteria, now, family)) found.set(url, job);
                            }
                        } else {
                            const government = group.filter((entry): entry is Extract<CareerWebReference, { kind: 'government' }> =>
                                entry.kind === 'government');
                            const paths = new Set(government.map((entry) => entry.sourcePath));
                            await (deps.governmentSearch || searchChatGovernmentJobs)(criteria, country, {
                                signal: execution.signal, now: deps.now, timeoutMs: execution.remainingMs(),
                                jobPaths: [...paths],
                                onJob: (job, sourceUrl) => {
                                    if (execution.signal.aborted) return;
                                    const reference = governmentReference(sourceUrl, job);
                                    if (!reference || reference.kind !== 'government') return;
                                    if (government.some((entry) => entry.sourcePath === reference.sourcePath && entry.url === reference.url) &&
                                        usable(job, criteria, now, family)) found.set(reference.url, job);
                                },
                            });
                        }
                    });
                } catch {
                    sourceFailures++;
                }
            }
        }));
        assertActive(deps.signal);
        sourceFailures += tasks.length - next;
        const jobs = refs.map((reference) => found.get(reference.url)).filter((job): job is JobsPortalJob => Boolean(job));
        return { jobs, sourceFailures };
    } finally {
        execution.cleanup();
    }
}
