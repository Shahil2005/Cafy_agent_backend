import type { SupabaseClient } from '@supabase/supabase-js';
import { JOB_CATALOG_LEVELS, JOBS_PAGE_SIZE, SEARCH_COUNT_TIMEOUT_MS } from './constants';
import { buildLevelSectorOnlyOrClause } from './levelMapping';
import {
    quoteSectorsForPostgrest,
} from './sectorPreferences';
import type { Sector } from './constants';
import { portalJobListColumns } from './publicResponse';
import { attachCompaniesToJobs } from './hydrateJobsWithCompanies';
import type { JobsPortalJob } from './types';
import { reportSearchCountTimeout, reportSearchRpcFallback } from './searchObservability';
import { normalizeSearchTerm } from './feedSeed';
import {
    jobsTableForCountry,
    isQualityUkCatalogue,
    searchJobsCountRpc,
    searchJobsPageRpc,
    type JobsCatalogCountry,
    type JobsTableName,
} from './jobsCatalog';

export type BrowseFeedSegment = 'preferred' | 'secondary' | 'levelOnly' | 'remainder';

export interface BrowseFeedSlicePlan {
    globalOffset: number;
    targetCount: number;
    preferredRange: { from: number; to: number } | null;
    secondaryRange: { from: number; to: number } | null;
    levelOnlyRange: { from: number; to: number } | null;
    remainderRange: { from: number; to: number } | null;
}

export interface BrowsePreferenceFilters {
    sectors: Sector[] | null;
    jobLevels: string[] | null;
    jobTypes: string[] | null;
}

/** Which preference dimensions must match for a browse ID fetch. */
export interface PrefMatchDims {
    sectors: boolean;
    levels: boolean;
    types: boolean;
}

export interface TwoPhaseBrowseParams {
    page?: number;
    limit?: number;
    maxJobsReturned?: number;
    excludedJobIds?: string[];
    excludedCompanyIds?: number[];
    companyId?: number;
    sectors: Sector[] | null;
    jobLevels: string[] | null;
    jobTypes?: string[] | null;
    /** Supabase jobs relation — UK `jobs` or Ireland `jobs_IR`. */
    jobsTable?: JobsTableName;
    catalogCountry?: JobsCatalogCountry;
}

/**
 * Multi-phase pagination:
 * preferred (sector+level) → secondary (sector only) → levelOnly → remainder.
 */
export function planMultiPhaseBrowseSlice(
    page: number,
    limit: number,
    preferredTotal: number,
    secondaryTotal: number,
    levelOnlyTotal: number,
    remainderTotal: number,
    maxJobsReturned?: number
): BrowseFeedSlicePlan {
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, limit);
    const globalOffset = (safePage - 1) * safeLimit;
    let targetCount = safeLimit;

    if (maxJobsReturned !== undefined) {
        const remainingAllowance = Math.max(0, maxJobsReturned - globalOffset);
        targetCount = Math.min(safeLimit, remainingAllowance);
    }

    const empty: BrowseFeedSlicePlan = {
        globalOffset,
        targetCount: 0,
        preferredRange: null,
        secondaryRange: null,
        levelOnlyRange: null,
        remainderRange: null,
    };

    if (targetCount <= 0) return empty;

    const phaseBounds = [
        { total: preferredTotal, key: 'preferred' as const },
        { total: secondaryTotal, key: 'secondary' as const },
        { total: levelOnlyTotal, key: 'levelOnly' as const },
        { total: remainderTotal, key: 'remainder' as const },
    ];

    let remaining = targetCount;
    let skip = globalOffset;
    const ranges: BrowseFeedSlicePlan = {
        globalOffset,
        targetCount,
        preferredRange: null,
        secondaryRange: null,
        levelOnlyRange: null,
        remainderRange: null,
    };

    for (const phase of phaseBounds) {
        if (remaining <= 0) break;
        if (skip >= phase.total) {
            skip -= phase.total;
            continue;
        }
        const from = skip;
        const available = phase.total - skip;
        const take = Math.min(available, remaining);
        const to = from + take - 1;
        if (phase.key === 'preferred') ranges.preferredRange = { from, to };
        if (phase.key === 'secondary') ranges.secondaryRange = { from, to };
        if (phase.key === 'levelOnly') ranges.levelOnlyRange = { from, to };
        if (phase.key === 'remainder') ranges.remainderRange = { from, to };
        remaining -= take;
        skip = 0;
    }

    return ranges;
}

/** Two-phase planner (no secondary / levelOnly tiers) — used by unit tests and legacy callers. */
export function planTwoPhaseBrowseSlice(
    page: number,
    limit: number,
    preferredTotal: number,
    maxJobsReturned?: number
): BrowseFeedSlicePlan {
    const multi = planMultiPhaseBrowseSlice(
        page,
        limit,
        preferredTotal,
        0,
        0,
        Number.MAX_SAFE_INTEGER,
        maxJobsReturned
    );
    return {
        ...multi,
        secondaryRange: null,
        levelOnlyRange: null,
    };
}

type BrowseQueryMode = 'preferred' | 'secondary' | 'levelOnly' | 'remainder' | 'all';

/** Sector-only and level-only partial tiers require both preference dimensions. */
export function usesSecondaryTier(filters: BrowsePreferenceFilters): boolean {
    return Boolean(filters.sectors?.length && filters.jobLevels?.length);
}

export function usesLevelOnlyTier(filters: BrowsePreferenceFilters): boolean {
    return usesSecondaryTier(filters);
}

function browseFiltersActive(filters: BrowsePreferenceFilters): boolean {
    return Boolean(filters.sectors?.length || filters.jobLevels?.length || filters.jobTypes?.length);
}
type RemainderPool = 'notInSector' | 'nullSector';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BrowseQuery = any;

function logBrowseFeedError(scope: string, error: unknown): void {
    if (error && typeof error === 'object') {
        const err = error as { message?: string; details?: string; code?: string; hint?: string };
        console.error(`[browseFeed] ${scope} error:`, {
            message: err.message,
            details: err.details,
            code: err.code,
            hint: err.hint,
        });
        return;
    }
    console.error(`[browseFeed] ${scope} error:`, error);
}


function compareBrowseJobs(a: JobsPortalJob, b: JobsPortalJob): number {
    const aCreated = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bCreated = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (aCreated !== bCreated) {
        return bCreated - aCreated;
    }
    return String(b.id).localeCompare(String(a.id));
}

function mergeBrowseJobs(poolA: JobsPortalJob[], poolB: JobsPortalJob[]): JobsPortalJob[] {
    const merged: JobsPortalJob[] = [];
    let i = 0;
    let j = 0;

    while (i < poolA.length || j < poolB.length) {
        if (i >= poolA.length) {
            merged.push(poolB[j++]);
            continue;
        }
        if (j >= poolB.length) {
            merged.push(poolA[i++]);
            continue;
        }

        if (compareBrowseJobs(poolA[i], poolB[j]) <= 0) {
            merged.push(poolA[i++]);
        } else {
            merged.push(poolB[j++]);
        }
    }

    return merged;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyBrowseFilters(
    query: BrowseQuery,
    mode: BrowseQueryMode,
    filters: BrowsePreferenceFilters,
    opts: Pick<TwoPhaseBrowseParams, 'excludedJobIds' | 'excludedCompanyIds' | 'companyId'>,
    remainderPool?: RemainderPool
) {
    let q = query;
    const sectors = filters.sectors ?? [];
    const jobLevels = filters.jobLevels ?? [];
    const jobTypes = filters.jobTypes ?? [];
    const hasSectors = sectors.length > 0;
    const hasLevels = jobLevels.length > 0;
    const hasJobTypes = jobTypes.length > 0;

    // Job type is a soft preference tier (see feedOrderBuilder) — not a hard filter here.
    void hasJobTypes;

    if (mode === 'preferred') {
        // Strict sector column only — never mix Other+embedding into preferred,
        // or mislabelled "Other" cards can rank above real Pharmaceutical matches.
        if (hasSectors && hasLevels) {
            q = q.in('sector', sectors).in('level', jobLevels);
        } else if (hasSectors) {
            q = q.in('sector', sectors);
        } else if (hasLevels) {
            q = q.in('level', jobLevels);
        }
    } else if (mode === 'secondary' && hasSectors && hasLevels) {
        // Sector match (strict), level mismatch
        q = q.in('sector', sectors);
        const levelOr = buildLevelSectorOnlyOrClause(jobLevels);
        if (levelOr) q = q.or(levelOr);
    } else if (mode === 'levelOnly' && hasSectors && hasLevels) {
        // Level match, sector not in prefs (includes Other / wrong labels)
        q = q.in('level', jobLevels);
        if (remainderPool === 'nullSector') {
            q = q.is('sector', null);
        } else {
            q = q.not('sector', 'in', `(${quoteSectorsForPostgrest(sectors)})`);
        }
    } else if (mode === 'remainder') {
        if (hasSectors) {
            if (remainderPool === 'nullSector') {
                q = q.is('sector', null);
            } else {
                q = q.not('sector', 'in', `(${quoteSectorsForPostgrest(sectors)})`);
            }
            // When levels are set, level-only matches are their own tier — exclude from remainder.
            if (hasLevels) {
                const levelOr = buildLevelSectorOnlyOrClause(jobLevels);
                if (levelOr) q = q.or(levelOr);
            }
        } else if (hasLevels) {
            const levelOr = buildLevelSectorOnlyOrClause(jobLevels);
            if (levelOr) q = q.or(levelOr);
        }
    }

    if (opts.excludedJobIds && opts.excludedJobIds.length > 0) {
        q = q.not('id', 'in', `(${opts.excludedJobIds.join(',')})`);
    }
    if (opts.excludedCompanyIds && opts.excludedCompanyIds.length > 0) {
        q = q.not('company_id', 'in', `(${opts.excludedCompanyIds.join(',')})`);
    }
    if (opts.companyId) {
        q = q.eq('company_id', opts.companyId);
    }

    return q.order('created_at', { ascending: false }).order('id', { ascending: false });
}

export interface BrowseJobIdRow {
    id: string;
    created_at: string;
    company_id: number;
}

function resolveJobsTable(params: { jobsTable?: JobsTableName }): JobsTableName {
    return params.jobsTable ?? jobsTableForCountry('uk');
}

/**
 * Fetch every job id + created_at + company_id for an exact preference-dimension match.
 * Used by the 8-tier deterministic browse order builder.
 */
export async function fetchAllBrowseJobIdsForDims(
    db: SupabaseClient,
    dims: PrefMatchDims,
    filters: BrowsePreferenceFilters,
    opts: Pick<TwoPhaseBrowseParams, 'excludedJobIds' | 'excludedCompanyIds' | 'companyId'>,
    jobsTable: JobsTableName = jobsTableForCountry('uk')
): Promise<BrowseJobIdRow[]> {
    const rows: BrowseJobIdRow[] = [];
    const batchSize = 1000;
    let from = 0;
    const sectors = filters.sectors ?? [];
    const jobLevels = filters.jobLevels ?? [];
    const jobTypes = filters.jobTypes ?? [];

    while (true) {
        let query = db.from(jobsTable).select('id, created_at, company_id');
        if (dims.sectors && sectors.length > 0) {
            query = query.in('sector', sectors);
        }
        if (dims.levels && jobLevels.length > 0) {
            query = query.in('level', jobLevels);
        }
        if (dims.types && jobTypes.length > 0) {
            query = query.in('job_type', jobTypes);
        }
        if (opts.excludedJobIds && opts.excludedJobIds.length > 0) {
            query = query.not('id', 'in', `(${opts.excludedJobIds.join(',')})`);
        }
        if (opts.excludedCompanyIds && opts.excludedCompanyIds.length > 0) {
            query = query.not('company_id', 'in', `(${opts.excludedCompanyIds.join(',')})`);
        }
        if (opts.companyId) {
            query = query.eq('company_id', opts.companyId);
        }
        query = query.order('created_at', { ascending: false }).order('id', { ascending: false });

        const { data, error } = await query.range(from, from + batchSize - 1);
        if (error) {
            logBrowseFeedError('fetchAllBrowseJobIdsForDims', error);
            break;
        }

        const batch = ((data as { id: string | number; created_at: string; company_id: number }[]) || []).map(
            (row) => ({ id: String(row.id), created_at: row.created_at, company_id: Number(row.company_id) })
        );
        rows.push(...batch);
        if (batch.length < batchSize) break;
        from += batchSize;
    }

    return rows;
}

/**
 * Fetch every job id + created_at + company_id in a browse pool (batched).
 */
export async function fetchAllBrowseJobIds(
    db: SupabaseClient,
    mode: BrowseQueryMode,
    filters: BrowsePreferenceFilters,
    opts: Pick<TwoPhaseBrowseParams, 'excludedJobIds' | 'excludedCompanyIds' | 'companyId'>,
    jobsTable: JobsTableName = jobsTableForCountry('uk')
): Promise<BrowseJobIdRow[]> {
    const rows: BrowseJobIdRow[] = [];
    const batchSize = 1000;
    let from = 0;

    while (true) {
        let query = db.from(jobsTable).select('id, created_at, company_id');
        query = applyBrowseFilters(query, mode, filters, opts);
        const { data, error } = await query.range(from, from + batchSize - 1);

        if (error) {
            logBrowseFeedError('fetchAllBrowseJobIds', error);
            break;
        }

        const batch = ((data as { id: string | number; created_at: string; company_id: number }[]) || []).map(
            (row) => ({ id: String(row.id), created_at: row.created_at, company_id: Number(row.company_id) })
        );
        rows.push(...batch);

        if (batch.length < batchSize) break;
        from += batchSize;
    }

    return rows;
}

async function countBrowsePool(
    db: SupabaseClient,
    mode: BrowseQueryMode,
    filters: BrowsePreferenceFilters,
    opts: Pick<TwoPhaseBrowseParams, 'excludedJobIds' | 'excludedCompanyIds' | 'companyId'>,
    jobsTable: JobsTableName
): Promise<number> {
    let query = db.from(jobsTable).select('id', { count: 'exact', head: true });
    query = applyBrowseFilters(query, mode, filters, opts);
    const { count, error } = await query;
    if (error) {
        logBrowseFeedError('countBrowsePool', error);
        return 0;
    }
    return count || 0;
}

function feedSegmentForMode(mode: BrowseQueryMode): BrowseFeedSegment {
    if (mode === 'preferred') return 'preferred';
    if (mode === 'secondary') return 'secondary';
    if (mode === 'levelOnly') return 'levelOnly';
    return 'remainder';
}

async function fetchBrowseRange(
    db: SupabaseClient,
    mode: BrowseQueryMode,
    filters: BrowsePreferenceFilters,
    opts: Pick<TwoPhaseBrowseParams, 'excludedJobIds' | 'excludedCompanyIds' | 'companyId'>,
    from: number,
    to: number,
    jobsTable: JobsTableName,
    remainderPool?: RemainderPool
): Promise<JobsPortalJob[]> {
    let query = db.from(jobsTable).select(portalJobListColumns(jobsTable));
    query = applyBrowseFilters(query, mode, filters, opts, remainderPool);
    const { data, error } = await query.range(from, to);
    if (error) {
        logBrowseFeedError('fetchBrowseRange', error);
        return [];
    }
    const segment = feedSegmentForMode(mode);
    const jobs = await attachCompaniesToJobs(db, (data as unknown as Record<string, unknown>[]) || []);
    return jobs.map((job) => ({
        ...job,
        feedSegment: segment,
    }));
}

/**
 * Remainder jobs are the complement of preferred matches. PostgREST `not.in`
 * misses rows with null sector, so merge that pool separately.
 */
async function fetchMergedRemainderRange(
    db: SupabaseClient,
    filters: BrowsePreferenceFilters,
    opts: Pick<TwoPhaseBrowseParams, 'excludedJobIds' | 'excludedCompanyIds' | 'companyId'>,
    from: number,
    to: number,
    jobsTable: JobsTableName
): Promise<JobsPortalJob[]> {
    if (!filters.sectors?.length) {
        return fetchBrowseRange(db, 'remainder', filters, opts, from, to, jobsTable);
    }

    const needed = to + 1;
    let fetchLimit = Math.max(needed + 100, 200);
    const maxFetchLimit = 500;

    while (fetchLimit <= maxFetchLimit) {
        const [notInSectorPool, nullSectorPool] = await Promise.all([
            fetchBrowseRange(db, 'remainder', filters, opts, 0, fetchLimit - 1, jobsTable, 'notInSector'),
            fetchBrowseRange(db, 'remainder', filters, opts, 0, fetchLimit - 1, jobsTable, 'nullSector'),
        ]);

        const merged = mergeBrowseJobs(notInSectorPool, nullSectorPool);
        if (merged.length > to) {
            return merged.slice(from, to + 1);
        }

        const exhausted =
            notInSectorPool.length < fetchLimit && nullSectorPool.length < fetchLimit;
        if (exhausted) {
            return merged.slice(from, to + 1);
        }

        fetchLimit += Math.max(needed, 500);
    }

    return [];
}

/**
 * Level-only jobs: level match but not hybrid sector match.
 * Null-sector rows need a separate pool (same reason as remainder).
 */
async function fetchMergedLevelOnlyRange(
    db: SupabaseClient,
    filters: BrowsePreferenceFilters,
    opts: Pick<TwoPhaseBrowseParams, 'excludedJobIds' | 'excludedCompanyIds' | 'companyId'>,
    from: number,
    to: number,
    jobsTable: JobsTableName
): Promise<JobsPortalJob[]> {
    if (!filters.sectors?.length || !filters.jobLevels?.length) {
        return [];
    }

    const needed = to + 1;
    let fetchLimit = Math.max(needed + 100, 200);
    const maxFetchLimit = 500;

    while (fetchLimit <= maxFetchLimit) {
        const [notInSectorPool, nullSectorPool] = await Promise.all([
            fetchBrowseRange(db, 'levelOnly', filters, opts, 0, fetchLimit - 1, jobsTable, 'notInSector'),
            fetchBrowseRange(db, 'levelOnly', filters, opts, 0, fetchLimit - 1, jobsTable, 'nullSector'),
        ]);

        const merged = mergeBrowseJobs(notInSectorPool, nullSectorPool);
        if (merged.length > to) {
            return merged.slice(from, to + 1);
        }

        const exhausted =
            notInSectorPool.length < fetchLimit && nullSectorPool.length < fetchLimit;
        if (exhausted) {
            return merged.slice(from, to + 1);
        }

        fetchLimit += Math.max(needed, 500);
    }

    return [];
}

export interface TwoPhaseBrowseResult {
    jobs: JobsPortalJob[];
    totalCount: number;
    preferredTotalCount: number;
    secondaryTotalCount: number;
    levelOnlyTotalCount: number;
    remainderTotalCount: number;
    browseHasSectorPreferences: boolean;
    browseHasLevelPreferences: boolean;
    catalogJobLevels: readonly string[];
    matchedJobLevels: string[];
}

function buildBrowsePreferenceFilters(params: TwoPhaseBrowseParams): BrowsePreferenceFilters {
    return {
        sectors: params.sectors,
        jobLevels: params.jobLevels,
        jobTypes: params.jobTypes ?? null,
    };
}

/**
 * Browse feed: sector+level → sector only → level only → remainder
 * (job type hard-filters every pool when set).
 */
export async function fetchTwoPhaseBrowseFeed(
    db: SupabaseClient,
    params: TwoPhaseBrowseParams
): Promise<TwoPhaseBrowseResult> {
    const page = Math.max(1, params.page || 1);
    const limit = params.limit ?? JOBS_PAGE_SIZE;
    const filters = buildBrowsePreferenceFilters(params);
    const hasSecondary = usesSecondaryTier(filters);
    const hasLevelOnly = usesLevelOnlyTier(filters);
    const matchedJobLevels = filters.jobLevels ?? [];
    const jobsTable = resolveJobsTable(params);

    const filterOpts = {
        excludedJobIds: params.excludedJobIds,
        excludedCompanyIds: params.excludedCompanyIds,
        companyId: params.companyId,
    };

    const emptyFilters: BrowsePreferenceFilters = {
        sectors: null,
        jobLevels: null,
        jobTypes: filters.jobTypes,
    };

    const [preferredTotalCount, secondaryTotalCount, levelMatchTotalCount, allTotalCount] =
        await Promise.all([
            countBrowsePool(db, 'preferred', filters, filterOpts, jobsTable),
            hasSecondary
                ? countBrowsePool(db, 'secondary', filters, filterOpts, jobsTable)
                : Promise.resolve(0),
            hasLevelOnly
                ? countBrowsePool(
                      db,
                      'preferred',
                      { sectors: null, jobLevels: filters.jobLevels, jobTypes: filters.jobTypes },
                      filterOpts,
                      jobsTable
                  )
                : Promise.resolve(0),
            countBrowsePool(db, 'all', emptyFilters, filterOpts, jobsTable),
        ]);
    // Level-only = all level matches minus sector+level (preferred).
    const levelOnlyCount = hasLevelOnly
        ? Math.max(0, levelMatchTotalCount - preferredTotalCount)
        : 0;
    const remainderTotalCount = Math.max(
        0,
        allTotalCount - preferredTotalCount - secondaryTotalCount - levelOnlyCount
    );
    const totalCount =
        preferredTotalCount + secondaryTotalCount + levelOnlyCount + remainderTotalCount;
    const plan = planMultiPhaseBrowseSlice(
        page,
        limit,
        preferredTotalCount,
        secondaryTotalCount,
        levelOnlyCount,
        remainderTotalCount,
        params.maxJobsReturned
    );

    const jobs: JobsPortalJob[] = [];

    if (plan.preferredRange) {
        jobs.push(
            ...(await fetchBrowseRange(
                db,
                'preferred',
                filters,
                filterOpts,
                plan.preferredRange.from,
                plan.preferredRange.to,
                jobsTable
            ))
        );
    }

    if (plan.secondaryRange && jobs.length < plan.targetCount) {
        jobs.push(
            ...(await fetchBrowseRange(
                db,
                'secondary',
                filters,
                filterOpts,
                plan.secondaryRange.from,
                plan.secondaryRange.to,
                jobsTable
            ))
        );
    }

    if (plan.levelOnlyRange && jobs.length < plan.targetCount) {
        jobs.push(
            ...(await fetchMergedLevelOnlyRange(
                db,
                filters,
                filterOpts,
                plan.levelOnlyRange.from,
                plan.levelOnlyRange.to,
                jobsTable
            ))
        );
    }

    if (plan.remainderRange && jobs.length < plan.targetCount) {
        jobs.push(
            ...(await fetchMergedRemainderRange(
                db,
                filters,
                filterOpts,
                plan.remainderRange.from,
                plan.remainderRange.to,
                jobsTable
            ))
        );
    }

    return {
        jobs: jobs.slice(0, plan.targetCount),
        totalCount,
        preferredTotalCount,
        secondaryTotalCount,
        levelOnlyTotalCount: levelOnlyCount,
        remainderTotalCount,
        browseHasSectorPreferences: Boolean(filters.sectors?.length),
        browseHasLevelPreferences: matchedJobLevels.length > 0,
        catalogJobLevels: JOB_CATALOG_LEVELS,
        matchedJobLevels,
    };
}

/**
 * Standard browse (no sector preferences).
 */
export async function fetchSinglePhaseBrowseFeed(
    db: SupabaseClient,
    params: Omit<TwoPhaseBrowseParams, 'sectors'> & { sectors?: null }
): Promise<TwoPhaseBrowseResult> {
    const page = Math.max(1, params.page || 1);
    const limit = params.limit ?? JOBS_PAGE_SIZE;
    const offset = (page - 1) * limit;
    let targetCount = limit;
    const jobsTable = resolveJobsTable(params);

    if (params.maxJobsReturned !== undefined) {
        targetCount = Math.min(limit, Math.max(0, params.maxJobsReturned - offset));
    }

    const filterOpts = {
        excludedJobIds: params.excludedJobIds,
        excludedCompanyIds: params.excludedCompanyIds,
        companyId: params.companyId,
    };

    const emptyFilters: BrowsePreferenceFilters = {
        sectors: null,
        jobLevels: null,
        jobTypes: params.jobTypes ?? null,
    };
    const totalCount = await countBrowsePool(db, 'all', emptyFilters, filterOpts, jobsTable);

    let jobs: JobsPortalJob[] = [];
    if (targetCount > 0) {
        jobs = await fetchBrowseRange(
            db,
            'all',
            emptyFilters,
            filterOpts,
            offset,
            offset + targetCount - 1,
            jobsTable
        );
    }

    return {
        jobs,
        totalCount,
        preferredTotalCount: 0,
        secondaryTotalCount: 0,
        levelOnlyTotalCount: 0,
        remainderTotalCount: totalCount,
        browseHasSectorPreferences: false,
        browseHasLevelPreferences: false,
        catalogJobLevels: JOB_CATALOG_LEVELS,
        matchedJobLevels: [],
    };
}

export interface SearchFeedFilterOpts {
    excludedJobIds?: string[];
    excludedCompanyIds?: number[];
    companyId?: number;
    /** Pre-fetched company IDs whose trading_name matches the where term */
    matchingCompanyIds?: number[];
    /** Soft-rank only — never hard-filters search results */
    sectors?: Sector[] | null;
    jobLevels?: string[] | null;
    jobTypes?: string[] | null;
    jobsTable?: JobsTableName;
    catalogCountry?: JobsCatalogCountry;
}

/** Role match: title / department only. */
export function buildRoleSearchOrFilter(roleTerm: string): string {
    const like = `%${roleTerm}%`;
    return [`title.ilike.${like}`, `department.ilike.${like}`].join(',');
}

/** Where match: location OR company ids. */
export function buildWhereSearchOrFilter(whereTerm: string, companyIds?: number[]): string {
    const like = `%${whereTerm}%`;
    const parts = [`location.ilike.${like}`];
    if (companyIds && companyIds.length > 0) {
        parts.push(`company_id.in.(${companyIds.join(',')})`);
    }
    return parts.join(',');
}

/**
 * @deprecated Prefer buildRoleSearchOrFilter / buildWhereSearchOrFilter.
 */
export function buildSearchOrFilter(qTerm: string, companyIds?: number[]): string {
    const like = `%${qTerm}%`;
    const parts = [
        `title.ilike.${like}`,
        `department.ilike.${like}`,
        `location.ilike.${like}`,
        `level.ilike.${like}`,
        `job_type.ilike.${like}`,
    ];
    if (companyIds && companyIds.length > 0) {
        parts.push(`company_id.in.(${companyIds.join(',')})`);
    }
    return parts.join(',');
}

function applyDualSearchFilters(
    query: BrowseQuery,
    roleTerm: string,
    whereTerm: string,
    opts: SearchFeedFilterOpts
): BrowseQuery {
    let q = query;
    if (roleTerm) {
        q = q.or(buildRoleSearchOrFilter(roleTerm));
    }
    if (whereTerm) {
        q = q.or(buildWhereSearchOrFilter(whereTerm, opts.matchingCompanyIds));
    }

    if (opts.excludedJobIds && opts.excludedJobIds.length > 0) {
        q = q.not('id', 'in', `(${opts.excludedJobIds.join(',')})`);
    }
    if (opts.excludedCompanyIds && opts.excludedCompanyIds.length > 0) {
        q = q.not('company_id', 'in', `(${opts.excludedCompanyIds.join(',')})`);
    }
    if (opts.companyId) {
        q = q.eq('company_id', opts.companyId);
    }

    return q;
}

function applySearchFilters(
    query: BrowseQuery,
    qTerm: string,
    opts: SearchFeedFilterOpts
): BrowseQuery {
    // Legacy single-term fallback path
    let q = query.or(buildSearchOrFilter(qTerm, opts.matchingCompanyIds));
    if (opts.excludedJobIds && opts.excludedJobIds.length > 0) {
        q = q.not('id', 'in', `(${opts.excludedJobIds.join(',')})`);
    }
    if (opts.excludedCompanyIds && opts.excludedCompanyIds.length > 0) {
        q = q.not('company_id', 'in', `(${opts.excludedCompanyIds.join(',')})`);
    }
    if (opts.companyId) {
        q = q.eq('company_id', opts.companyId);
    }
    return q;
}

export interface SearchPageParams extends SearchFeedFilterOpts {
    offset: number;
    limit: number;
    roleTerm?: string;
    whereTerm?: string;
}

function buildSearchRpcParams(roleTerm: string, whereTerm: string, opts: SearchFeedFilterOpts) {
    return {
        p_role_query: roleTerm || null,
        p_where_query: whereTerm || null,
        p_company_ids: opts.matchingCompanyIds?.length ? opts.matchingCompanyIds : null,
        p_excluded_ids: opts.excludedJobIds?.length ? opts.excludedJobIds : null,
        p_excluded_company_ids: opts.excludedCompanyIds?.length ? opts.excludedCompanyIds : null,
        p_company_id: opts.companyId ?? null,
        p_sectors: opts.sectors?.length ? opts.sectors : null,
        p_levels: opts.jobLevels?.length ? opts.jobLevels : null,
        p_job_types: opts.jobTypes?.length ? opts.jobTypes : null,
    };
}

function resolveSearchTerms(params: SearchPageParams | SearchFeedFilterOpts & { roleTerm?: string; whereTerm?: string }): {
    roleTerm: string;
    whereTerm: string;
} {
    return {
        roleTerm: normalizeSearchTerm(params.roleTerm || ''),
        whereTerm: normalizeSearchTerm(params.whereTerm || ''),
    };
}

function searchSoftRankScore(
    row: { sector: string | null; level: string | null; job_type: string | null },
    opts: SearchFeedFilterOpts
): number {
    const sectors = opts.sectors ?? [];
    const levels = opts.jobLevels ?? [];
    const types = opts.jobTypes ?? [];
    const hasS = sectors.length > 0;
    const hasL = levels.length > 0;
    const hasT = types.length > 0;
    const inS = hasS && row.sector != null && sectors.includes(row.sector as Sector);
    const inL = hasL && row.level != null && levels.includes(row.level);
    const inT = hasT && row.job_type != null && types.includes(row.job_type);
    if (hasS && hasL && hasT && inS && inL && inT) return 0;
    if (hasS && hasT && inS && inT) return 1;
    if (hasS && hasL && inS && inL) return 2;
    if (hasS && inS) return 3;
    if (hasL && hasT && inL && inT) return 4;
    if (hasL && inL) return 5;
    if (hasT && inT) return 6;
    return 7;
}

/**
 * One page of preference soft-ranked search results. No global result cap.
 * Requires search RPCs in Supabase (`search_jobs_page` / `search_jobs_ir_page`).
 */
export async function fetchSearchJobPage(
    db: SupabaseClient,
    params: SearchPageParams
): Promise<string[]> {
    const { roleTerm, whereTerm } = resolveSearchTerms(params);
    if (!roleTerm && !whereTerm) return [];

    const safeOffset = Math.max(0, params.offset);
    const safeLimit = Math.min(Math.max(1, params.limit), JOBS_PAGE_SIZE);
    const catalogCountry = params.catalogCountry ?? 'uk';
    const rpcName = searchJobsPageRpc(catalogCountry);

    try {
        const { data, error } = await db.rpc(rpcName, {
            ...buildSearchRpcParams(roleTerm, whereTerm, params),
            p_offset: safeOffset,
            p_limit: safeLimit,
        });

        if (error) {
            reportSearchRpcFallback(rpcName, error.message);
            if (catalogCountry === 'uk' && isQualityUkCatalogue()) throw new Error('Job search is temporarily unavailable. Please try again.');
            return fetchSearchJobPageFallback(db, roleTerm, whereTerm, params);
        }

        return ((data as { job_id: number | string }[]) || []).map((r) => String(r.job_id));
    } catch (err) {
        if (catalogCountry === 'uk' && isQualityUkCatalogue()) throw err;
        reportSearchRpcFallback(
            rpcName,
            err instanceof Error ? err.message : 'unknown error'
        );
        return fetchSearchJobPageFallback(db, roleTerm, whereTerm, params);
    }
}

export interface SearchMatchCountResult {
    count: number;
    /** False when the count query timed out and a minimum estimate was used. */
    exact: boolean;
}

/** Uncapped match count for search UI pagination. */
export async function fetchSearchMatchCount(
    db: SupabaseClient,
    opts: SearchFeedFilterOpts & { roleTerm?: string; whereTerm?: string }
): Promise<SearchMatchCountResult> {
    const { roleTerm, whereTerm } = resolveSearchTerms(opts);
    if (!roleTerm && !whereTerm) return { count: 0, exact: true };

    const catalogCountry = opts.catalogCountry ?? 'uk';
    const rpcName = searchJobsCountRpc(catalogCountry);
    const queryLabel = [roleTerm, whereTerm].filter(Boolean).join('|');

    try {
        const rpcPromise = db.rpc(rpcName, buildSearchRpcParams(roleTerm, whereTerm, opts));
        const outcome = await Promise.race([
            rpcPromise.then((result) => ({ kind: 'result' as const, result })),
            new Promise<{ kind: 'timeout' }>((resolve) => {
                setTimeout(() => resolve({ kind: 'timeout' }), SEARCH_COUNT_TIMEOUT_MS);
            }),
        ]);

        if (outcome.kind === 'timeout') {
            reportSearchCountTimeout(queryLabel, SEARCH_COUNT_TIMEOUT_MS);
            return { count: 0, exact: false };
        }

        const { data, error } = outcome.result;
        if (error) {
            reportSearchRpcFallback(rpcName, error.message);
            if (catalogCountry === 'uk' && isQualityUkCatalogue()) throw new Error('Job search is temporarily unavailable. Please try again.');
            const count = await fetchSearchMatchCountFallback(db, roleTerm, whereTerm, opts);
            return { count, exact: true };
        }

        const count = typeof data === 'number' ? data : Number(data);
        return {
            count: Number.isFinite(count) && count >= 0 ? count : 0,
            exact: true,
        };
    } catch (err) {
        if (catalogCountry === 'uk' && isQualityUkCatalogue()) throw err;
        reportSearchRpcFallback(
            rpcName,
            err instanceof Error ? err.message : 'unknown error'
        );
        const count = await fetchSearchMatchCountFallback(db, roleTerm, whereTerm, opts);
        return { count, exact: true };
    }
}

export function estimateSearchTotalCount(
    globalOffset: number,
    pageIds: string[],
    targetCount: number
): number {
    if (pageIds.length === 0) {
        return globalOffset;
    }
    if (pageIds.length >= targetCount) {
        return globalOffset + pageIds.length + 1;
    }
    return globalOffset + pageIds.length;
}

async function fetchSearchJobPageFallback(
    db: SupabaseClient,
    roleTerm: string,
    whereTerm: string,
    params: SearchPageParams
): Promise<string[]> {
    const safeOffset = Math.max(0, params.offset);
    const safeLimit = Math.min(Math.max(1, params.limit), JOBS_PAGE_SIZE);
    const jobsTable = resolveJobsTable(params);

    let query = db.from(jobsTable).select('id, sector, level, job_type, created_at');
    query = applyDualSearchFilters(query, roleTerm, whereTerm, params);
    // Fetch a window large enough to soft-rank then slice (degraded path only).
    const fetchLimit = Math.min(safeOffset + safeLimit + 200, 500);
    const { data, error } = await query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(fetchLimit);

    if (error) {
        logBrowseFeedError('fetchSearchJobPageFallback', error);
        return [];
    }

    type Row = {
        id: string | number;
        sector: string | null;
        level: string | null;
        job_type: string | null;
        created_at: string | null;
    };
    const rows = ((data as Row[]) || []).slice().sort((a, b) => {
        const rankDiff = searchSoftRankScore(a, params) - searchSoftRankScore(b, params);
        if (rankDiff !== 0) return rankDiff;
        const aTime = a.created_at || '';
        const bTime = b.created_at || '';
        if (aTime !== bTime) return aTime < bTime ? 1 : -1;
        return String(b.id).localeCompare(String(a.id));
    });

    return rows.slice(safeOffset, safeOffset + safeLimit).map((row) => String(row.id));
}

async function fetchSearchMatchCountFallback(
    db: SupabaseClient,
    roleTerm: string,
    whereTerm: string,
    opts: SearchFeedFilterOpts
): Promise<number> {
    const jobsTable = resolveJobsTable(opts);
    let query = db.from(jobsTable).select('id', { count: 'exact', head: true });
    query = applyDualSearchFilters(query, roleTerm, whereTerm, opts);
    const { count, error } = await query;

    if (error) {
        logBrowseFeedError('fetchSearchMatchCountFallback', error);
        return 0;
    }

    return count || 0;
}
