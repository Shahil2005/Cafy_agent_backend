import type { SupabaseClient } from '@supabase/supabase-js';
import {
    reloadChatCatalogueCandidatesByIds,
    searchChatCatalogue,
} from './chatCatalogue';
import { ChatExecutionError } from './chatExecution';
import { chatSearchSchema, type ChatSearch } from './chatIntent';
import { matchChatJob } from './chatMatching';
import { canonicalJobUrl } from './chatWebUrls';
import type { CareerMatchCoverage } from './careerMatchTypes';
import type { JobsCatalogCountry } from './jobsCatalog';
import type { JobsPortalJob } from './types';
import { careerTitleInFamily, careerTitleMatches } from './careerMatchProfile';
import { careerRoleRetrievalQuery } from './careerMatchRoleQuery';

const MAX_CANDIDATES = 120;
const MAX_ROLE_QUERIES = 6;
const MAX_SCANNED = 1000;

export interface CareerMatchCatalogueDependencies {
    /** Test injection; production uses the shared SELECT-only catalogue transport. */
    client?: SupabaseClient;
    signal?: AbortSignal;
    /** Equivalent titles for an explicit role (the role first); reloads keep the same family. */
    roleTitles?: string[];
}

export interface CareerCandidateCollection {
    jobs: JobsPortalJob[];
    coverage: CareerMatchCoverage;
}

function assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ChatExecutionError('cancelled');
}

function validateCountry(country: JobsCatalogCountry): void {
    if (country !== 'uk' && country !== 'ireland') throw new Error('Invalid catalogue country');
}

/** Missing descriptions cannot support a CV comparison; source expiry never becomes an active advert. */
function usableCandidate(job: JobsPortalJob, search: ChatSearch, family: string[]): boolean {
    const expiry = job.listingSource?.expiresAt;
    // Match the ranker's readable-description floor before the retrieval cap,
    // otherwise placeholder rows can hide genuinely comparable later adverts.
    const description = job.description?.slice(0, 20_000).replace(/<[^>]*>/g, ' ').trim();
    return Boolean(
        job.id && job.title.trim() && description && description.length >= 50 && canonicalJobUrl(job.url) &&
        (!expiry || (Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) > Date.now())) &&
        (!search.role || careerTitleInFamily(job.title, family)) &&
        matchChatJob(job, { ...search, role: '' }).matches,
    );
}

/** The explicit role always leads its family; titles are already validated by the role expander. */
function roleFamily(criteria: ChatSearch, titles: string[]): string[] {
    if (!criteria.role) return [];
    const family = [criteria.role, ...titles.map((title) => title.trim()).filter(Boolean)];
    return [...new Map(family.map((title) => [title.toLowerCase(), title])).values()];
}

/**
 * Retrieve a bounded pool for later CV ranking, not the portal's first visible page.
 * Inferred roles are retrieval alternatives only; explicit student criteria remain hard filters.
 * No AI, cache, preference migration, usage accounting, RPC or database writes occur here.
 */
export async function collectCareerCandidates(
    search: ChatSearch,
    country: JobsCatalogCountry,
    roleQueries: string[],
    dependencies: CareerMatchCatalogueDependencies = {},
): Promise<CareerCandidateCollection> {
    const criteria = chatSearchSchema.parse(search);
    validateCountry(country);
    assertActive(dependencies.signal);
    if (!Array.isArray(roleQueries) || roleQueries.some((role) => typeof role !== 'string' || role.length > 100))
        throw new Error('Invalid career candidate queries');
    if (criteria.kind === 'part-time' && country !== 'uk') throw new Error('Part-time catalogue is UK only');
    const coverage: CareerMatchCoverage = {
        catalogueScanned: 0,
        candidates: 0,
        limitReached: false,
        sourceFailures: 0,
    };
    if (criteria.unsupported.length) return { jobs: [], coverage };
    const family = roleFamily(criteria, roleQueries);
    // An explicit role searches its whole family of equivalent titles; otherwise CV directions are alternatives.
    const proposed = criteria.role ? family : roleQueries.map((role) => role.trim()).filter(Boolean);
    const uniqueQueries = [...new Map(proposed.map((role) => [role.toLowerCase(), role])).values()];
    const queries = uniqueQueries.slice(0, MAX_ROLE_QUERIES);
    if (!queries.length) queries.push('');
    coverage.limitReached = uniqueQueries.length > queries.length;
    const candidateBudget = Math.floor(MAX_CANDIDATES / queries.length);
    const scanBudget = Math.floor(MAX_SCANNED / queries.length);
    const jobs: JobsPortalJob[] = [];
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const role of queries) {
        assertActive(dependencies.signal);
        const queryIds = new Set<string>();
        const queryUrls = new Set<string>();
        const accept = (job: JobsPortalJob): boolean => {
            if (!usableCandidate(job, criteria, family)) return false;
            const url = canonicalJobUrl(job.url)!;
            if (ids.has(job.id) || urls.has(url) || queryIds.has(job.id) || queryUrls.has(url)) return false;
            queryIds.add(job.id);
            queryUrls.add(url);
            return true;
        };
        try {
            const result = await searchChatCatalogue(
                { ...criteria, role }, country, undefined,
                { client: dependencies.client, signal: dependencies.signal, candidateMode: {
                    maxJobs: candidateBudget, maxScan: scanBudget, accept,
                    roleQuery: careerRoleRetrievalQuery(role),
                    roleMatches: (job) => !role || careerTitleMatches(job.title, role),
                } },
            );
            assertActive(dependencies.signal);
            coverage.catalogueScanned += result.coverage.scanned;
            coverage.limitReached ||= result.coverage.limitReached || result.totalCount > result.jobs.length;
            coverage.sourceFailures += result.coverage.sourceFailures || 0;
            for (const job of result.jobs) {
                if (!usableCandidate(job, criteria, family)) continue;
                const url = canonicalJobUrl(job.url)!;
                if (ids.has(job.id) || urls.has(url)) continue;
                ids.add(job.id);
                urls.add(url);
                jobs.push(job);
            }
        } catch (error) {
            assertActive(dependencies.signal);
            if (error instanceof ChatExecutionError) throw error;
            // Do not include service errors, private database URLs or queries in output/logs.
            coverage.sourceFailures++;
        }
    }
    coverage.candidates = jobs.length;
    return { jobs, coverage };
}

/** Re-read and revalidate only the fixed ranked identities supplied by a verified server cursor. */
export async function reloadCareerCandidates(
    ids: string[],
    search: ChatSearch,
    country: JobsCatalogCountry,
    dependencies: CareerMatchCatalogueDependencies = {},
): Promise<JobsPortalJob[]> {
    const criteria = chatSearchSchema.parse(search);
    validateCountry(country);
    assertActive(dependencies.signal);
    const { roleTitles, ...transport } = dependencies;
    const family = roleFamily(criteria, roleTitles || []);
    const jobs = await reloadChatCatalogueCandidatesByIds(ids, { ...criteria, role: '' }, country, transport);
    const seen = new Set<string>();
    return jobs.filter((job) => {
        if (!usableCandidate(job, criteria, family)) return false;
        const url = canonicalJobUrl(job.url)!;
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
    });
}
