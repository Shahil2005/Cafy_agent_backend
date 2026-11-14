/**
 * Production companies directory — UK `jobs` and Ireland `jobs_IR`.
 * Sorted by live job count (most open roles first). RPC preferred; catalog-aware fallbacks.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
    COMPANIES_PAGE_SIZE,
    FREE_COMPANIES_LIMIT,
    JOBS_PAGE_SIZE,
    JOBS_SEARCH_QUERY_MAX_LENGTH,
} from './constants';
import { portalJobListColumns } from './publicResponse';
import { isLowProfilePortalJob } from './lowProfileJobs';
import { loadQualityCompanyCounts } from './qualityCompanyCounts';
import {
    attachCompaniesToJobs,
    fetchCompaniesByIds,
    fetchCompanyById,
} from './hydrateJobsWithCompanies';
import {
    jobsTableForCountry,
    requiresFreshUkFeed,
    isQualityUkCatalogue,
    isStrictUkSponsorshipFeed,
    listPortalCompaniesCountRpc,
    listPortalCompaniesRpc,
    type JobsCatalogCountry,
} from './jobsCatalog';
import { getJobsPortalRedis } from './redisClient';
import type { DirectoryPortalCompany, JobsPortalJob } from './types';
import {
    directoryEmployerToPortalCompany,
    fetchDirectoryEmployersByIds,
    isDirectoryTableMissing,
} from './directoryEmployers';
import { isCompaniesRegisterEnabled, isRegisterOnlyCompanyId } from './directoryIds';

const COUNTS_CACHE_TTL_SECONDS = 900;
const JOB_ID_PAGE = 1_000;
const GROUP_PAGE = 1_000;
const MAX_GROUP_ROWS = 50_000;
const MAX_AGGREGATION_ROWS = 250_000;
const COMPANY_COUNT_PAGE = 1_000;
const MAX_COMPANY_ROWS = 100_000;

/** PostgREST schema cache: skip RPC after a confirmed miss for this process. */
let rpcSupportedJobs: boolean | null = null;
let rpcSupportedDirectory: boolean | null = null;

let _supabase: SupabaseClient | null = null;

function getSupabaseAdmin(): SupabaseClient {
    if (_supabase) return _supabase;

    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) {
        throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
    }

    _supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    return _supabase;
}

export interface RankedCompanyCount {
    company_id: number;
    job_count: number;
    register_volume?: number;
}

export interface ListPortalCompaniesParams {
    catalogCountry: JobsCatalogCountry;
    page?: number;
    q?: string;
    pageSize?: number;
}

export interface ListPortalCompaniesResult {
    companies: DirectoryPortalCompany[];
    totalCount: number;
    totalPages: number;
    catalogCountry: JobsCatalogCountry;
}

export interface CompanyDirectoryDetail {
    company: DirectoryPortalCompany;
    jobs: JobsPortalJob[];
    totalCount: number;
    totalPages: number;
    catalogCountry: JobsCatalogCountry;
}

export function sanitizeCompanySearchQuery(raw?: string): string | undefined {
    const trimmed = (raw || '').trim().slice(0, JOBS_SEARCH_QUERY_MAX_LENGTH);
    return trimmed || undefined;
}

function escapeIlikePattern(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function companyCountsCacheKey(country: JobsCatalogCountry): string {
    return `jobs:company-job-counts:v5:${country}`;
}

function freePreviewCompanyIdsKey(country: JobsCatalogCountry): string {
    return `jobs:free-company-ids:v4:${country}`;
}

function isMissingRpcError(message: string | undefined): boolean {
    if (!message) return false;
    return /could not find the function|schema cache|does not exist|404/i.test(message);
}

function toRankedRow(raw: unknown): RankedCompanyCount | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const companyId = Number(row.company_id ?? row.companyId);
    const jobCount = Number(row.job_count ?? row.jobCount ?? row.count);
    const registerVolume = Number(row.register_volume ?? row.registerVolume ?? 0);
    if (!Number.isInteger(companyId) || companyId <= 0) return null;
    if (!Number.isFinite(jobCount) || jobCount < 0) return null;
    return {
        company_id: companyId,
        job_count: Math.floor(jobCount),
        register_volume: Number.isFinite(registerVolume) ? Math.max(0, Math.floor(registerVolume)) : 0,
    };
}

function sortRankedByJobCount(rows: RankedCompanyCount[]): RankedCompanyCount[] {
    return [...rows].sort(
        (a, b) =>
            b.job_count - a.job_count ||
            (b.register_volume || 0) - (a.register_volume || 0) ||
            a.company_id - b.company_id
    );
}

async function tryListViaRpc(
    catalogCountry: JobsCatalogCountry,
    search: string | undefined,
    offset: number,
    limit: number,
    includeRegister = false
): Promise<{ rows: RankedCompanyCount[]; totalCount: number } | null> {
    const rpcFlag = includeRegister ? rpcSupportedDirectory : rpcSupportedJobs;
    if (rpcFlag === false) return null;

    const db = getSupabaseAdmin();
    const listName = listPortalCompaniesRpc(includeRegister);
    const countName = listPortalCompaniesCountRpc(includeRegister);
    const rpcArgs = {
        p_catalog: catalogCountry,
        p_search: search ?? null,
        p_offset: offset,
        p_limit: limit,
    };
    let { data, error } = await db.rpc(listName, rpcArgs).order('job_count', { ascending: false });

    if (error && isMissingRpcError(error.message)) {
        if (includeRegister) rpcSupportedDirectory = false;
        else rpcSupportedJobs = false;
        return null;
    }

    if (error) {
        ({ data, error } = await db.rpc(listName, rpcArgs));
    }

    if (error) {
        if (isMissingRpcError(error.message)) {
            if (includeRegister) rpcSupportedDirectory = false;
            else rpcSupportedJobs = false;
            return null;
        }
        console.warn('[companiesDirectory]', listName, 'RPC error:', error.message);
        return null;
    }

    if (includeRegister) rpcSupportedDirectory = true;
    else rpcSupportedJobs = true;

    const { data: countRaw, error: countError } = await db.rpc(countName, {
        p_catalog: catalogCountry,
        p_search: search ?? null,
    });

    if (countError) {
        if (isMissingRpcError(countError.message)) {
            if (includeRegister) rpcSupportedDirectory = false;
            else rpcSupportedJobs = false;
            return null;
        }
        console.warn('[companiesDirectory]', countName, 'RPC error:', countError.message);
        return null;
    }

    const rows = sortRankedByJobCount(
        (Array.isArray(data) ? data : [])
            .map(toRankedRow)
            .filter((row): row is RankedCompanyCount => !!row)
    );

    const totalCount = typeof countRaw === 'number' ? countRaw : Number(countRaw);
    return {
        rows,
        totalCount: Number.isFinite(totalCount) ? Math.max(0, Math.floor(totalCount)) : rows.length,
    };
}

async function loadRankedCountsViaGroupBy(
    catalogCountry: JobsCatalogCountry
): Promise<RankedCompanyCount[] | null> {
    const db = getSupabaseAdmin();
    const jobsTable = jobsTableForCountry(catalogCountry);
    const selects = [
        { columns: 'company_id, job_count:id.count()', order: 'job_count' },
        { columns: 'company_id, count()', order: 'count' },
    ] as const;

    for (const { columns, order } of selects) {
        const merged = new Map<number, number>();
        let from = 0;
        let failed = false;

        while (from < MAX_GROUP_ROWS) {
            const to = from + GROUP_PAGE - 1;
            let query = db.from(jobsTable).select(columns).not('company_id', 'is', null);
            let { data, error } = await query.order(order, { ascending: false }).range(from, to);

            if (error) {
                query = db.from(jobsTable).select(columns).not('company_id', 'is', null);
                ({ data, error } = await query.range(from, to));
            }

            if (error) {
                console.warn('[companiesDirectory] live job-count group-by failed:', error.message);
                failed = true;
                break;
            }

            const rows =
                ((data as Array<{ company_id?: number; job_count?: number; count?: number }> | null) ||
                    []);
            if (rows.length === 0) break;

            for (const row of rows) {
                const parsed = toRankedRow(row);
                if (!parsed) continue;
                const prev = merged.get(parsed.company_id) || 0;
                if (parsed.job_count > prev) merged.set(parsed.company_id, parsed.job_count);
            }

            if (rows.length < GROUP_PAGE) break;
            from += GROUP_PAGE;
        }

        if (failed) continue;

        const ranked = sortRankedByJobCount(
            [...merged.entries()].map(([company_id, job_count]) => ({ company_id, job_count }))
        );
        if (ranked.length > 0) return ranked;
    }

    return null;
}

async function readCachedRankedCounts(
    catalogCountry: JobsCatalogCountry
): Promise<RankedCompanyCount[] | null> {
    const redis = getJobsPortalRedis();
    if (!redis) return null;
    try {
        const cached = await redis.get<RankedCompanyCount[]>(companyCountsCacheKey(catalogCountry));
        if (Array.isArray(cached) && cached.length > 0) {
            return sortRankedByJobCount(cached.map(toRankedRow).filter((row): row is RankedCompanyCount => !!row));
        }
    } catch (err) {
        console.warn('[companiesDirectory] counts cache read failed:', err);
    }
    return null;
}

async function writeCachedRankedCounts(
    catalogCountry: JobsCatalogCountry,
    ranked: RankedCompanyCount[]
): Promise<void> {
    const redis = getJobsPortalRedis();
    if (!redis || ranked.length === 0) return;
    try {
        await redis.set(companyCountsCacheKey(catalogCountry), ranked, { ex: COUNTS_CACHE_TTL_SECONDS });
    } catch (err) {
        console.warn('[companiesDirectory] counts cache write failed:', err);
    }
}

/**
 * UK `companies.active_jobs_count` is a text-ish value in PostgREST — never ORDER BY
 * it in SQL ( "9" ranks above "16" and NHS "6616" falls off page 1 ). Parse + sort in JS.
 */
async function loadRankedCountsFromCompaniesColumn(): Promise<RankedCompanyCount[]> {
    const db = getSupabaseAdmin();
    const counts = new Map<number, number>();
    let from = 0;

    while (from < MAX_COMPANY_ROWS) {
        const to = from + COMPANY_COUNT_PAGE - 1;
        const { data, error } = await db
            .from('companies')
            .select('id, active_jobs_count')
            .not('active_jobs_count', 'is', null)
            .order('id', { ascending: true })
            .range(from, to);

        if (error) {
            console.warn('[companiesDirectory] companies.active_jobs_count scan failed:', error.message);
            return [];
        }

        const rows = (data as Array<{ id?: number; active_jobs_count?: unknown }> | null) || [];
        if (rows.length === 0) break;

        for (const row of rows) {
            const parsed = toRankedRow({ company_id: row.id, job_count: row.active_jobs_count });
            if (!parsed) continue;
            counts.set(parsed.company_id, parsed.job_count);
        }

        if (rows.length < COMPANY_COUNT_PAGE) break;
        from += COMPANY_COUNT_PAGE;
    }

    return sortRankedByJobCount(
        [...counts.entries()].map(([company_id, job_count]) => ({ company_id, job_count }))
    );
}

async function loadRankedCountsFromJobsTable(
    catalogCountry: JobsCatalogCountry
): Promise<RankedCompanyCount[]> {
    const db = getSupabaseAdmin();
    if (catalogCountry === 'uk' && isQualityUkCatalogue()) return loadQualityCompanyCounts(db,isStrictUkSponsorshipFeed());
    const jobsTable = jobsTableForCountry(catalogCountry);
    const counts = new Map<number, number>();
    let from = 0;

    while (from < MAX_AGGREGATION_ROWS) {
        const to = from + JOB_ID_PAGE - 1;
        const { data, error } = await db
            .from(jobsTable)
            .select('company_id')
            .order('id', { ascending: true })
            .range(from, to);

        if (error) {
            console.error('[companiesDirectory] job-count aggregation failed:', error.message);
            break;
        }

        const rows = (data as Array<{ company_id?: number }> | null) || [];
        if (rows.length === 0) break;

        for (const row of rows) {
            const id = Number(row.company_id);
            if (!Number.isInteger(id) || id <= 0) continue;
            counts.set(id, (counts.get(id) || 0) + 1);
        }

        if (rows.length < JOB_ID_PAGE) break;
        from += JOB_ID_PAGE;
    }

    const ranked = sortRankedByJobCount(
        [...counts.entries()].map(([company_id, job_count]) => ({ company_id, job_count }))
    );

    return ranked;
}

export async function clearCompanyJobCountsCache(): Promise<void> {
    const redis = getJobsPortalRedis();
    if (!redis) return;
    try {
        await redis.del(
            companyCountsCacheKey('uk'),
            companyCountsCacheKey('ireland'),
            freePreviewCompanyIdsKey('uk'),
            freePreviewCompanyIdsKey('ireland')
        );
    } catch (err) {
        console.warn('[companiesDirectory] failed to clear company counts cache:', err);
    }
}

/** Top N company ids for the Free directory — search cannot expand this set. */
export async function getFreePreviewCompanyIds(
    catalogCountry: JobsCatalogCountry
): Promise<number[]> {
    const redis = requiresFreshUkFeed(catalogCountry) ? null : getJobsPortalRedis();
    const cacheKey = freePreviewCompanyIdsKey(catalogCountry);
    if (redis) {
        try {
            const cached = await redis.get<number[]>(cacheKey);
            if (Array.isArray(cached) && cached.length > 0) {
                return cached
                    .map((id) => Number(id))
                    .filter((id) => Number.isInteger(id) && id > 0)
                    .slice(0, FREE_COMPANIES_LIMIT);
            }
        } catch (err) {
            console.warn('[companiesDirectory] free preview ids cache read failed:', err);
        }
    }

    const listed = await listPortalCompanies({
        catalogCountry,
        page: 1,
        pageSize: Math.max(FREE_COMPANIES_LIMIT * 4, 40),
    });
    const ids = listed.companies
        .filter((company) => (company.active_jobs_count || 0) > 0 && !isRegisterOnlyCompanyId(company.id))
        .map((company) => company.id)
        .filter((id) => Number.isInteger(id) && id > 0)
        .slice(0, FREE_COMPANIES_LIMIT);

    if (redis && ids.length > 0) {
        try {
            await redis.set(cacheKey, ids, { ex: COUNTS_CACHE_TTL_SECONDS });
        } catch (err) {
            console.warn('[companiesDirectory] free preview ids cache write failed:', err);
        }
    }

    return ids;
}

export async function isFreePreviewCompany(
    catalogCountry: JobsCatalogCountry,
    companyId: number
): Promise<boolean> {
    if (!Number.isInteger(companyId) || companyId <= 0) return false;
    const ids = await getFreePreviewCompanyIds(catalogCountry);
    return ids.includes(companyId);
}

async function searchMatchingCompanyIds(
    search: string,
    catalogCountry: JobsCatalogCountry
): Promise<Set<number>> {
    const db = getSupabaseAdmin();
    const safe = escapeIlikePattern(search).replace(/,/g, ' ');
    const ids = new Set<number>();

    const { data, error } = await db
        .from('companies')
        .select('id')
        .or(`trading_name.ilike.%${safe}%,companies_house_name.ilike.%${safe}%`)
        .limit(500);

    if (error) {
        console.error('[companiesDirectory] company name search failed:', error.message);
    } else {
        for (const row of (data as Array<{ id?: number }> | null) || []) {
            const id = Number(row.id);
            if (Number.isInteger(id) && id > 0) ids.add(id);
        }
    }

    const matchedCompanyIds = [...ids];

    if (isCompaniesRegisterEnabled()) {
        const { data: dirData, error: dirError } = await db
            .from('directory_employers')
            .select('id')
            .eq('catalog', catalogCountry)
            .or(`display_name.ilike.%${safe}%,legal_name.ilike.%${safe}%`)
            .limit(500);
        if (dirError) {
            if (!isDirectoryTableMissing(dirError.message)) {
                console.warn('[companiesDirectory] directory search failed:', dirError.message);
            }
        } else {
            for (const row of (dirData as Array<{ id?: number }> | null) || []) {
                const id = Number(row.id);
                if (Number.isInteger(id) && id > 0) ids.add(id);
            }
        }

        if (matchedCompanyIds.length > 0) {
            const { data: linked, error: linkedError } = await db
                .from('directory_employers')
                .select('id')
                .eq('catalog', catalogCountry)
                .in(
                    'company_id',
                    matchedCompanyIds.map((id) => String(id))
                );
            if (linkedError) {
                if (!isDirectoryTableMissing(linkedError.message)) {
                    console.warn(
                        '[companiesDirectory] directory company_id link search failed:',
                        linkedError.message
                    );
                }
            } else {
                for (const row of (linked as Array<{ id?: number }> | null) || []) {
                    const id = Number(row.id);
                    if (Number.isInteger(id) && id > 0) ids.add(id);
                }
            }
        }
    }

    return ids;
}

async function listUkViaActiveJobsColumn(
    search: string | undefined,
    page: number,
    pageSize: number
): Promise<{ rows: RankedCompanyCount[]; totalCount: number }> {
    let ranked = await loadRankedCountsFromCompaniesColumn();
    if (search) {
        const matches = await searchMatchingCompanyIds(search, 'uk');
        ranked = ranked.filter((row) => matches.has(row.company_id));
    }
    const totalCount = ranked.length;
    const from = (page - 1) * pageSize;
    return { rows: ranked.slice(from, from + pageSize), totalCount };
}

async function hydrateDirectoryCompanies(
    ranked: RankedCompanyCount[]
): Promise<DirectoryPortalCompany[]> {
    if (ranked.length === 0) return [];
    const ids = ranked.map((row) => row.company_id);
    const atsCompanies = await fetchCompaniesByIds(getSupabaseAdmin(), ids);
    const byId = new Map(atsCompanies.map((company) => [company.id, company]));

    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0 && isCompaniesRegisterEnabled()) {
        const directoryRows = await fetchDirectoryEmployersByIds(getSupabaseAdmin(), missing);
        for (const row of directoryRows) {
            const rankedRow = ranked.find((r) => r.company_id === row.id);
            byId.set(row.id, directoryEmployerToPortalCompany(row, rankedRow?.job_count));
        }
    }

    const directory: DirectoryPortalCompany[] = [];
    for (const row of ranked) {
        const company = byId.get(row.company_id);
        if (!company) continue;
        directory.push({
            ...company,
            active_jobs_count: row.job_count,
        });
    }
    return directory.sort(
        (a, b) =>
            Number(b.active_jobs_count || 0) - Number(a.active_jobs_count || 0) ||
            a.trading_name.localeCompare(b.trading_name)
    );
}

async function loadRankedFromDirectoryTable(
    catalogCountry: JobsCatalogCountry
): Promise<RankedCompanyCount[]> {
    if (!isCompaniesRegisterEnabled()) return [];
    const db = getSupabaseAdmin();
    const merged: RankedCompanyCount[] = [];
    let from = 0;
    const page = 1_000;

    while (from < 500_000) {
        const to = from + page - 1;
        const { data, error } = await db
            .from('directory_employers')
            .select('id, job_count, register_volume')
            .eq('catalog', catalogCountry)
            .order('job_count', { ascending: false })
            .order('register_volume', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to);

        if (error) {
            if (!isDirectoryTableMissing(error.message)) {
                console.warn('[companiesDirectory] directory rank scan failed:', error.message);
            }
            return [];
        }

        const rows = (data as Array<Record<string, unknown>> | null) || [];
        if (rows.length === 0) break;
        for (const row of rows) {
            const parsed = toRankedRow({
                company_id: row.id,
                job_count: row.job_count,
                register_volume: row.register_volume,
            });
            if (parsed) merged.push(parsed);
        }
        if (rows.length < page) break;
        from += page;
    }

    return sortRankedByJobCount(merged);
}

async function rankedCountsForCatalog(
    catalogCountry: JobsCatalogCountry
): Promise<RankedCompanyCount[]> {
    if (requiresFreshUkFeed(catalogCountry)) return loadRankedCountsFromJobsTable(catalogCountry);
    const cached = await readCachedRankedCounts(catalogCountry);
    if (cached && cached.length > 0) return cached;

    let ranked: RankedCompanyCount[] = [];

    if (isCompaniesRegisterEnabled()) {
        ranked = await loadRankedFromDirectoryTable(catalogCountry);
    }

    if (ranked.length > 0 && isCompaniesRegisterEnabled()) {
        const live = await loadRankedCountsFromJobsTable(catalogCountry);
        if (live.length > 0) {
            const liveMap = new Map(live.map((row) => [row.company_id, row.job_count]));
            ranked = sortRankedByJobCount(
                ranked.map((row) => {
                    if (isRegisterOnlyCompanyId(row.company_id)) return row;
                    const liveCount = liveMap.get(row.company_id);
                    return liveCount != null ? { ...row, job_count: liveCount } : row;
                })
            );
        }
    } else if (ranked.length === 0 && catalogCountry === 'uk') {
        ranked = await loadRankedCountsFromCompaniesColumn();
    }

    if (ranked.length === 0) {
        ranked = await loadRankedCountsFromJobsTable(catalogCountry);
    }

    if (ranked.length > 0) {
        const top = ranked.slice(0, 5).map((row) => `${row.company_id}:${row.job_count}`);
        console.info('[companiesDirectory] ranked', catalogCountry, 'top', top.join(', '));
        await writeCachedRankedCounts(catalogCountry, ranked);
    }

    return ranked;
}

export async function listPortalCompanies(
    params: ListPortalCompaniesParams
): Promise<ListPortalCompaniesResult> {
    const catalogCountry = params.catalogCountry;
    const pageSize = Math.min(50, Math.max(1, params.pageSize || COMPANIES_PAGE_SIZE));
    const page = Math.max(1, params.page || 1);
    const search = sanitizeCompanySearchQuery(params.q);
    const offset = (page - 1) * pageSize;

    if (requiresFreshUkFeed(catalogCountry)) {
        let ranked = await loadRankedCountsFromJobsTable(catalogCountry);
        if (search) {
            const matches = await searchMatchingCompanyIds(search, catalogCountry);
            ranked = ranked.filter(row => matches.has(row.company_id));
        }
        return { companies: await hydrateDirectoryCompanies(ranked.slice(offset, offset + pageSize)),
            totalCount: ranked.length, totalPages: Math.max(1, Math.ceil(ranked.length / pageSize)), catalogCountry };
    }

    if (search) {
        let ranked = await rankedCountsForCatalog(catalogCountry);
        const matches = await searchMatchingCompanyIds(search, catalogCountry);
        ranked = ranked.filter((row) => matches.has(row.company_id));

        if (ranked.length === 0 && catalogCountry === 'uk') {
            const fallback = await listUkViaActiveJobsColumn(search, page, pageSize);
            return {
                companies: await hydrateDirectoryCompanies(fallback.rows),
                totalCount: fallback.totalCount,
                totalPages: Math.max(1, Math.ceil(fallback.totalCount / pageSize) || 1),
                catalogCountry,
            };
        }

        const totalCount = ranked.length;
        const pageRows = ranked.slice(offset, offset + pageSize);
        return {
            companies: await hydrateDirectoryCompanies(pageRows),
            totalCount,
            totalPages: Math.max(1, Math.ceil(totalCount / pageSize) || 1),
            catalogCountry,
        };
    }

    const includeRegister = isCompaniesRegisterEnabled();
    const rpc = await tryListViaRpc(catalogCountry, search, offset, pageSize, includeRegister);
    if (rpc && !(includeRegister && rpc.totalCount === 0 && !search)) {
        return {
            companies: await hydrateDirectoryCompanies(rpc.rows),
            totalCount: rpc.totalCount,
            totalPages: Math.max(1, Math.ceil(rpc.totalCount / pageSize) || 1),
            catalogCountry,
        };
    }

    let ranked = await rankedCountsForCatalog(catalogCountry);

    if (ranked.length === 0 && catalogCountry === 'uk') {
        const fallback = await listUkViaActiveJobsColumn(search, page, pageSize);
        return {
            companies: await hydrateDirectoryCompanies(fallback.rows),
            totalCount: fallback.totalCount,
            totalPages: Math.max(1, Math.ceil(fallback.totalCount / pageSize) || 1),
            catalogCountry,
        };
    }

    const totalCount = ranked.length;
    const pageRows = ranked.slice(offset, offset + pageSize);

    return {
        companies: await hydrateDirectoryCompanies(pageRows),
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / pageSize) || 1),
        catalogCountry,
    };
}

export async function getCompanyDirectoryDetail(params: {
    companyId: number;
    catalogCountry: JobsCatalogCountry;
    page?: number;
    pageSize?: number;
}): Promise<CompanyDirectoryDetail | null> {
    const db = getSupabaseAdmin();
    const companyId = params.companyId;
    if (!Number.isInteger(companyId) || companyId <= 0) return null;

    const company = await fetchCompanyById(db, companyId);
    let portalCompany = company
        ? { ...company, active_jobs_count: 0 }
        : null;

    if (!portalCompany && isCompaniesRegisterEnabled()) {
        const [directoryRow] = await fetchDirectoryEmployersByIds(db, [companyId]);
        if (directoryRow) {
            portalCompany = directoryEmployerToPortalCompany(directoryRow);
        }
    }

    if (!portalCompany) return null;

    const jobsCompanyId = isRegisterOnlyCompanyId(companyId)
        ? null
        : companyId;

    const catalogCountry = params.catalogCountry;
    const pageSize = Math.min(50, Math.max(1, params.pageSize || JOBS_PAGE_SIZE));
    const page = Math.max(1, params.page || 1);

    if (!jobsCompanyId) {
        return {
            company: { ...portalCompany, active_jobs_count: 0 },
            jobs: [],
            totalCount: 0,
            totalPages: 1,
            catalogCountry,
        };
    }

    const jobsTable = jobsTableForCountry(catalogCountry);
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { count, error: countError } = await db
        .from(jobsTable)
        .select('id', { count: 'exact', head: true })
        .eq('company_id', jobsCompanyId);

    if (countError) {
        console.error('[companiesDirectory] company job count failed:', countError.message);
    }

    const totalCount = count ?? 0;

    const { data, error } = await db
        .from(jobsTable)
        .select(portalJobListColumns(jobsTable))
        .eq('company_id', jobsCompanyId)
        .order('created_at', { ascending: false })
        .range(from, to);

    if (error) {
        console.error('[companiesDirectory] company jobs fetch failed:', error.message);
        return {
            company: { ...portalCompany, active_jobs_count: totalCount },
            jobs: [],
            totalCount,
            totalPages: Math.max(1, Math.ceil(totalCount / pageSize) || 1),
            catalogCountry,
        };
    }

    const jobs = (await attachCompaniesToJobs(
        db,
        ((data as unknown) as Record<string, unknown>[] | null) || []
    )).filter((job) => !isLowProfilePortalJob(job));

    return {
        company: { ...portalCompany, active_jobs_count: totalCount },
        jobs,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / pageSize) || 1),
        catalogCountry,
    };
}
