import type { SupabaseClient } from '@supabase/supabase-js';
import { JOB_CATALOG_LEVELS, JOBS_PAGE_SIZE } from './constants';
import {
    buildBrowseFilterHash,
    buildFeedOrderCacheKey,
    getCachedFeedOrder,
    getJobsCatalogVersion,
    setCachedFeedOrder,
} from './feedOrderCache';
import {
    buildPreferenceFeedOrder,
    buildSinglePhaseFeedOrder,
} from './feedOrderBuilder';
import { fetchJobsByIdsWithCompanies } from './hydrateJobsWithCompanies';
import { isLowProfilePortalJob } from './lowProfileJobs';
import type { JobsPortalJob } from './types';
import type {
    BrowsePreferenceFilters,
    TwoPhaseBrowseParams,
    TwoPhaseBrowseResult,
} from './browseFeed';
import type { BrowseFilterOpts } from './feedOrderCache';
import {
    fetchSearchJobPage,
    fetchSearchMatchCount,
    estimateSearchTotalCount,
} from './browseFeed';
import {
    buildSearchCacheHashes,
    buildSearchCountCacheKey,
    buildSearchPageCacheKey,
    getCachedSearchCount,
    getCachedSearchPage,
    setCachedSearchCount,
    setCachedSearchPage,
} from './searchPageCache';
import type { BuiltFeedOrder } from './feedOrderBuilder';
import {
    jobsTableForCountry,
    requiresFreshUkFeed,
    type JobsCatalogCountry,
    type JobsTableName,
} from './jobsCatalog';

const ID_BATCH_SIZE = 1000;

function resolveCatalog(
    params: { jobsTable?: JobsTableName; catalogCountry?: JobsCatalogCountry }
): { jobsTable: JobsTableName; catalogCountry: JobsCatalogCountry } {
    const catalogCountry = params.catalogCountry ?? 'uk';
    const jobsTable = params.jobsTable ?? jobsTableForCountry('uk');
    return { jobsTable, catalogCountry };
}

function slicePageIds(
    orderedIds: string[],
    page: number,
    limit: number,
    maxJobsReturned?: number
): string[] {
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, limit);
    const globalOffset = (safePage - 1) * safeLimit;
    let targetCount = safeLimit;

    if (maxJobsReturned !== undefined) {
        targetCount = Math.min(safeLimit, Math.max(0, maxJobsReturned - globalOffset));
    }

    if (targetCount <= 0) return [];
    return orderedIds.slice(globalOffset, globalOffset + targetCount);
}

function feedSegmentForId(
    id: string,
    preferredIdSet: Set<string>,
    secondaryIdSet: Set<string>,
    levelOnlyIdSet: Set<string>
): JobsPortalJob['feedSegment'] {
    if (preferredIdSet.has(id)) return 'preferred';
    if (secondaryIdSet.has(id)) return 'secondary';
    if (levelOnlyIdSet.has(id)) return 'levelOnly';
    return 'remainder';
}

async function hydrateJobsByIds(
    db: SupabaseClient,
    ids: string[],
    preferredIdSet: Set<string>,
    secondaryIdSet: Set<string>,
    levelOnlyIdSet: Set<string>,
    jobsTable: JobsTableName
): Promise<JobsPortalJob[]> {
    if (ids.length === 0) return [];

    const jobsById = new Map<string, JobsPortalJob>();

    for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
        const batch = ids.slice(i, i + ID_BATCH_SIZE);
        const batchJobs = await fetchJobsByIdsWithCompanies(db, batch, jobsTable);
        for (const row of batchJobs) {
            jobsById.set(String(row.id), row);
        }
    }

    const hydrated: JobsPortalJob[] = [];
    for (const id of ids) {
        const job = jobsById.get(id);
        if (!job) continue;
        hydrated.push({
            ...job,
            feedSegment: feedSegmentForId(id, preferredIdSet, secondaryIdSet, levelOnlyIdSet),
        });
    }
    return hydrated;
}

function orderedIdsFromCache(cached: {
    preferredIds: string[];
    secondaryIds: string[];
    levelOnlyIds: string[];
    remainderIds: string[];
}): string[] {
    return [
        ...cached.preferredIds,
        ...cached.secondaryIds,
        ...cached.levelOnlyIds,
        ...cached.remainderIds,
    ];
}

/** Build and store full browse order without blocking the HTTP response. */
export function warmBrowseFeedCacheAsync(
    db: SupabaseClient,
    params: TwoPhaseBrowseParams & { shuffleSeed: string }
): void {
    const { jobsTable, catalogCountry } = resolveCatalog(params);
    const filterOpts: BrowseFilterOpts = {
        excludedJobIds: params.excludedJobIds,
        excludedCompanyIds: params.excludedCompanyIds,
        companyId: params.companyId,
    };
    const browseFilters: BrowsePreferenceFilters = {
        sectors: params.sectors,
        jobLevels: params.jobLevels,
        jobTypes: params.jobTypes ?? null,
    };
    const filterHash = buildBrowseFilterHash(filterOpts);
    const cacheKey = buildFeedOrderCacheKey(params.shuffleSeed, filterHash, catalogCountry);
    const hasPreferences = browsePreferencesActive(browseFilters);

    void (async () => {
        try {
            const existing = await getCachedFeedOrder(cacheKey);
            if (existing) return;

            const order = hasPreferences
                ? await buildPreferenceFeedOrder(
                      db,
                      browseFilters,
                      filterOpts,
                      params.shuffleSeed,
                      jobsTable
                  )
                : await buildSinglePhaseFeedOrder(db, filterOpts, params.shuffleSeed, jobsTable);
            const catalogVersion = await getJobsCatalogVersion();

            await setCachedFeedOrder(cacheKey, {
                preferredIds: order.preferredIds,
                secondaryIds: order.secondaryIds,
                levelOnlyIds: order.levelOnlyIds,
                remainderIds: order.remainderIds,
                catalogVersion,
            });
        } catch (err) {
            console.warn('[shuffledBrowseFeed] warmBrowseFeedCacheAsync failed:', err);
        }
    })();
}

async function resolveFeedOrder(
    cacheKey: string,
    shuffleSeed: string,
    build: () => Promise<BuiltFeedOrder>
): Promise<{ order: BuiltFeedOrder; cache: 'hit' | 'miss'; buildMs: number }> {
    const cached = await getCachedFeedOrder(cacheKey);
    if (cached) {
        const secondaryIds = cached.secondaryIds ?? [];
        const levelOnlyIds = cached.levelOnlyIds ?? [];
        return {
            order: {
                preferredIds: cached.preferredIds,
                secondaryIds,
                levelOnlyIds,
                remainderIds: cached.remainderIds,
                orderedIds: orderedIdsFromCache({
                    preferredIds: cached.preferredIds,
                    secondaryIds,
                    levelOnlyIds,
                    remainderIds: cached.remainderIds,
                }),
                preferredIdSet: new Set(cached.preferredIds),
                secondaryIdSet: new Set(secondaryIds),
                levelOnlyIdSet: new Set(levelOnlyIds),
            },
            cache: 'hit',
            buildMs: 0,
        };
    }

    const startedAt = Date.now();
    const order = await build();
    const buildMs = Date.now() - startedAt;
    const catalogVersion = await getJobsCatalogVersion();

    await setCachedFeedOrder(cacheKey, {
        preferredIds: order.preferredIds,
        secondaryIds: order.secondaryIds,
        levelOnlyIds: order.levelOnlyIds,
        remainderIds: order.remainderIds,
        catalogVersion,
    });

    return { order, cache: 'miss', buildMs };
}

function logFeedTiming(meta: {
    cache: 'hit' | 'miss';
    buildMs: number;
    idCount: number;
    page: number;
    hasPreferences: boolean;
    mode?: 'browse' | 'search';
}): void {
    console.log('[jobs-feed]', meta);
}

function browsePreferencesActive(filters: BrowsePreferenceFilters): boolean {
    return Boolean(filters.sectors?.length || filters.jobLevels?.length || filters.jobTypes?.length);
}

async function serveShuffledPage(
    db: SupabaseClient,
    params: {
        page: number;
        limit: number;
        maxJobsReturned?: number;
        shuffleSeed: string;
        filterOpts: BrowseFilterOpts;
        browseFilters: BrowsePreferenceFilters;
        jobsTable: JobsTableName;
        catalogCountry: JobsCatalogCountry;
    }
): Promise<TwoPhaseBrowseResult & { cache: 'hit' | 'miss'; buildMs: number }> {
    const filterHash = buildBrowseFilterHash(params.filterOpts);
    const cacheKey = buildFeedOrderCacheKey(
        params.shuffleSeed,
        filterHash,
        params.catalogCountry
    );
    const hasPreferences = browsePreferencesActive(params.browseFilters);

    const { order, cache, buildMs } = await resolveFeedOrder(cacheKey, params.shuffleSeed, () =>
        hasPreferences
            ? buildPreferenceFeedOrder(
                  db,
                  params.browseFilters,
                  params.filterOpts,
                  params.shuffleSeed,
                  params.jobsTable
              )
            : buildSinglePhaseFeedOrder(
                  db,
                  params.filterOpts,
                  params.shuffleSeed,
                  params.jobsTable
              )
    );

    const pageIds = slicePageIds(
        order.orderedIds,
        params.page,
        params.limit,
        params.maxJobsReturned
    );
    const jobs = await hydrateJobsByIds(
        db,
        pageIds,
        order.preferredIdSet,
        order.secondaryIdSet,
        order.levelOnlyIdSet,
        params.jobsTable
    );

    logFeedTiming({
        cache,
        buildMs,
        idCount: order.orderedIds.length,
        page: params.page,
        hasPreferences,
    });

    return {
        jobs,
        totalCount: order.orderedIds.length,
        preferredTotalCount: order.preferredIds.length,
        secondaryTotalCount: order.secondaryIds.length,
        levelOnlyTotalCount: order.levelOnlyIds.length,
        remainderTotalCount: order.remainderIds.length,
        browseHasSectorPreferences: Boolean(params.browseFilters.sectors?.length),
        browseHasLevelPreferences: Boolean(params.browseFilters.jobLevels?.length),
        catalogJobLevels: JOB_CATALOG_LEVELS,
        matchedJobLevels: params.browseFilters.jobLevels ?? [],
        cache,
        buildMs,
    };
}

/**
 * Browse with user preferences: sector+level → sector only → level only → remainder.
 */
export async function fetchShuffledBrowseFeed(
    db: SupabaseClient,
    params: TwoPhaseBrowseParams & { shuffleSeed: string }
): Promise<TwoPhaseBrowseResult> {
    const page = Math.max(1, params.page || 1);
    const limit = params.limit ?? JOBS_PAGE_SIZE;
    const { jobsTable, catalogCountry } = resolveCatalog(params);
    const filterOpts: BrowseFilterOpts = {
        excludedJobIds: params.excludedJobIds,
        excludedCompanyIds: params.excludedCompanyIds,
        companyId: params.companyId,
    };
    const browseFilters: BrowsePreferenceFilters = {
        sectors: params.sectors,
        jobLevels: params.jobLevels,
        jobTypes: params.jobTypes ?? null,
    };

    const result = await serveShuffledPage(db, {
        page,
        limit,
        maxJobsReturned: params.maxJobsReturned,
        shuffleSeed: params.shuffleSeed,
        filterOpts,
        browseFilters,
        jobsTable,
        catalogCountry,
    });

    const { cache: _cache, buildMs: _buildMs, ...feed } = result;
    return feed;
}

/** @deprecated Use fetchShuffledBrowseFeed */
export async function fetchShuffledTwoPhaseBrowseFeed(
    db: SupabaseClient,
    params: TwoPhaseBrowseParams & { shuffleSeed: string; sectors: import('./constants').Sector[] }
): Promise<TwoPhaseBrowseResult> {
    return fetchShuffledBrowseFeed(db, params);
}

/** @deprecated Use fetchShuffledBrowseFeed */
export async function fetchShuffledSinglePhaseBrowseFeed(
    db: SupabaseClient,
    params: Omit<TwoPhaseBrowseParams, 'sectors'> & {
        sectors?: null;
        shuffleSeed: string;
    }
): Promise<TwoPhaseBrowseResult> {
    return fetchShuffledBrowseFeed(db, {
        ...params,
        sectors: null,
        jobLevels: params.jobLevels ?? null,
        jobTypes: params.jobTypes ?? null,
    });
}

export interface ShuffledSearchFeedParams {
    page?: number;
    limit?: number;
    maxJobsReturned?: number;
    roleTerm: string;
    whereTerm: string;
    excludedJobIds?: string[];
    excludedCompanyIds?: number[];
    companyId?: number;
    /** Pre-fetched company IDs whose trading_name matches the where term */
    matchingCompanyIds?: number[];
    sectors?: import('./constants').Sector[] | null;
    jobLevels?: string[] | null;
    jobTypes?: string[] | null;
    jobsTable?: JobsTableName;
    catalogCountry?: JobsCatalogCountry;
}

export interface ShuffledSearchFeedResult {
    jobs: JobsPortalJob[];
    totalCount: number;
}

/**
 * Search feed — one page of soft-ranked hard matches at a time (no global cap).
 * Page-level Redis cache avoids re-running Postgres search on pagination.
 */
export async function fetchShuffledSearchFeed(
    db: SupabaseClient,
    params: ShuffledSearchFeedParams
): Promise<ShuffledSearchFeedResult> {
    const page = Math.max(1, params.page || 1);
    const limit = params.limit ?? JOBS_PAGE_SIZE;
    const { jobsTable, catalogCountry } = resolveCatalog(params);
    const filterOpts: BrowseFilterOpts = {
        excludedJobIds: params.excludedJobIds,
        excludedCompanyIds: params.excludedCompanyIds,
        companyId: params.companyId,
    };
    const searchOpts = {
        ...filterOpts,
        matchingCompanyIds: params.matchingCompanyIds,
        sectors: params.sectors ?? null,
        jobLevels: params.jobLevels ?? null,
        jobTypes: params.jobTypes ?? null,
        jobsTable,
        catalogCountry,
        roleTerm: params.roleTerm,
        whereTerm: params.whereTerm,
    };

    const globalOffset = (page - 1) * limit;
    let targetCount = limit;
    if (params.maxJobsReturned !== undefined) {
        targetCount = Math.min(limit, Math.max(0, params.maxJobsReturned - globalOffset));
    }
    if (targetCount <= 0) {
        return { jobs: [], totalCount: 0 };
    }

    const catalogVersion = await getJobsCatalogVersion();
    const { queryHash, filterHash } = buildSearchCacheHashes(
        params.roleTerm,
        params.whereTerm,
        filterOpts,
        {
            sectors: params.sectors,
            jobLevels: params.jobLevels,
            jobTypes: params.jobTypes,
            matchingCompanyIds: params.matchingCompanyIds,
        }
    );
    const pageCacheKey = buildSearchPageCacheKey(
        catalogVersion,
        queryHash,
        filterHash,
        page,
        catalogCountry
    );
    const countCacheKey = buildSearchCountCacheKey(
        catalogVersion,
        queryHash,
        filterHash,
        catalogCountry
    );

    const startedAt = Date.now();
    let pageIds: string[];
    let totalCount: number;
    let cache: 'hit' | 'miss' = 'miss';
    const pageParams = {
        ...searchOpts,
        offset: globalOffset,
        limit: targetCount,
    };

    const strictUk = requiresFreshUkFeed(catalogCountry);
    const cachedPageIds = strictUk ? null : await getCachedSearchPage(pageCacheKey);
    const cachedCount = strictUk ? null : await getCachedSearchCount(countCacheKey);

    if (cachedPageIds && cachedCount !== null) {
        pageIds = cachedPageIds;
        totalCount = cachedCount;
        cache = 'hit';
    } else {
        let countResult: Awaited<ReturnType<typeof fetchSearchMatchCount>> | null = null;

        if (cachedPageIds) {
            pageIds = cachedPageIds;
        } else if (cachedCount !== null) {
            pageIds = await fetchSearchJobPage(db, pageParams);
            await setCachedSearchPage(pageCacheKey, pageIds);
        } else if (page === 1) {
            const [ids, count] = await Promise.all([
                fetchSearchJobPage(db, pageParams),
                fetchSearchMatchCount(db, searchOpts),
            ]);
            pageIds = ids;
            countResult = count;
            await setCachedSearchPage(pageCacheKey, pageIds);
        } else {
            pageIds = await fetchSearchJobPage(db, pageParams);
            countResult = await fetchSearchMatchCount(db, searchOpts);
            await setCachedSearchPage(pageCacheKey, pageIds);
        }

        if (cachedCount !== null) {
            totalCount = cachedCount;
        } else if (countResult) {
            totalCount = countResult.exact
                ? countResult.count
                : estimateSearchTotalCount(globalOffset, pageIds, targetCount);
            if (countResult.exact) {
                await setCachedSearchCount(countCacheKey, totalCount);
            }
        } else {
            countResult = await fetchSearchMatchCount(db, searchOpts);
            totalCount = countResult.exact
                ? countResult.count
                : estimateSearchTotalCount(globalOffset, pageIds, targetCount);
            if (countResult.exact) {
                await setCachedSearchCount(countCacheKey, totalCount);
            }
        }
    }

    const buildMs = Date.now() - startedAt;
    // Keep RPC / soft-rank order — do not company-interleave (that is browse-only).
    // Skip low-profile roles and pull the next matches so a search page stays full.
    const visible: JobsPortalJob[] = [];
    let skipOffset = globalOffset;
    let rounds = 0;
    while (visible.length < targetCount && rounds < 8) {
        const ids =
            rounds === 0
                ? pageIds
                : await fetchSearchJobPage(db, {
                      ...pageParams,
                      offset: skipOffset,
                      limit: targetCount,
                  });
        if (ids.length === 0) break;
        const hydrated = await hydrateJobsByIds(db, ids, new Set(), new Set(), new Set(), jobsTable);
        for (const job of hydrated) {
            if (isLowProfilePortalJob(job)) continue;
            visible.push(job);
            if (visible.length >= targetCount) break;
        }
        skipOffset += ids.length;
        if (ids.length < targetCount) break;
        rounds += 1;
    }
    const jobs = visible.slice(0, targetCount);

    logFeedTiming({
        cache,
        buildMs,
        idCount: totalCount,
        page,
        hasPreferences: false,
        mode: 'search',
    });

    return { jobs, totalCount };
}
