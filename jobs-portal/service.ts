import { createClient, SupabaseClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import {
    ALLOWED_SECTORS,
    JOB_CATALOG_LEVELS,
    Sector,
    JOBS_PAGE_SIZE,
    JOBS_COMPANY_NAME_SEARCH_LIMIT,
    SPONSORSHIP_PAGE_SIZE,
    SPONSORSHIP_SEARCH_MAX_LENGTH,
} from './constants';
import {
    resolveUserBrowseSectors,
    resolveUserBrowseExperienceLevels,
} from './userPreferences';
import { toPublicPortalJobs } from './publicResponse';
import {
    sanitizeUserSectors,
} from './sectorPreferences';
import {
    expandUserLevelsToJobLevels,
    sanitizeUserExperienceLevels,
} from './levelMapping';
import { sanitizeUserJobTypes } from './jobTypeMapping';
import { listPortalCompanies } from './companiesDirectory';
import {
    fetchSinglePhaseBrowseFeed,
    fetchTwoPhaseBrowseFeed,
} from './browseFeed';
import {
    fetchShuffledBrowseFeed,
    fetchShuffledSearchFeed,
} from './shuffledBrowseFeed';
import { deriveFeedShuffleSeed, normalizeSearchTerm } from './feedSeed';
import { attachJobDescriptions, fetchPortalJobByIdWithCompany } from './hydrateJobsWithCompanies';
import {
    getCachedGlobalJobCount,
} from './feedOrderCache';
import type { TwoPhaseBrowseResult } from './browseFeed';
import {
    jobsTableForCountry,
    requiresFreshUkFeed,
    type JobsCatalogCountry,
} from './jobsCatalog';

// ---------------------------------------------------------------------------
// Supabase Admin Client (service-role, read-only queries against jobs tables)
// ---------------------------------------------------------------------------

let _supabase: SupabaseClient | null = null;

function getSupabaseAdmin(): SupabaseClient {
    if (_supabase) return _supabase;

    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

    if (!url || !key) {
        throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
    }

    _supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false }
    });

    return _supabase;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { JobsPortalJob, JobsPortalCompany, PublicJobsPortalCompany, DirectoryPortalCompany } from './types';
import type { JobsPortalJob } from './types';
import { isLowProfilePortalJob } from './lowProfileJobs';

export interface GetJobsParams {
    page?: number;
    excludedJobIds?: string[];
    excludedCompanyIds?: number[];
    /** @deprecated Prefer role + where. Legacy single-box search. */
    q?: string;
    /** Job role search (title / department) */
    role?: string;
    /** Company or location search */
    where?: string;
    userSectors?: string[];
    userExperienceLevels?: string[];
    userJobTypes?: string[];
    companyId?: number;
    userId?: string;
    /** Free tier: never fetch or return more than this many job rows */
    maxJobsReturned?: number;
    /** Skip Redis feed cache — use after preference changes for an immediate fresh slice */
    refreshPreferences?: boolean;
    /** Jobs catalog country — resolved from preferences.locations */
    catalogCountry?: JobsCatalogCountry;
}

export interface JobsFeedResult {
    jobs: JobsPortalJob[];
    totalPages: number;
    totalCount: number;
    globalTotalCount: number;
    preferredTotalCount?: number;
    secondaryTotalCount?: number;
    levelOnlyTotalCount?: number;
    remainderTotalCount?: number;
    browseHasSectorPreferences?: boolean;
    browseHasLevelPreferences?: boolean;
    browseHasJobTypePreferences?: boolean;
    catalogJobLevels?: readonly string[];
    matchedJobLevels?: string[];
    matchedJobTypes?: string[];
    /** Which country catalog this feed was served from */
    catalogCountry: JobsCatalogCountry;
}

export async function getPortalJobById(
    jobId: string,
    catalogCountry: JobsCatalogCountry = 'uk'
): Promise<JobsPortalJob | null> {
    const id = jobId.trim();
    if (!id) return null;
    const job = await fetchPortalJobByIdWithCompany(getSupabaseAdmin(), id, jobsTableForCountry(catalogCountry));
    if (!job || isLowProfilePortalJob(job)) return null;
    return job;
}

/** Batch JDs for an already-authorized chat page; never expand the selected catalogue or IDs. */
export async function attachPortalChatJobDescriptions(
    jobs: JobsPortalJob[],
    catalogCountry: JobsCatalogCountry,
): Promise<JobsPortalJob[]> {
    if (jobs.length > JOBS_PAGE_SIZE) throw new Error('Chat description hydration exceeds page size');
    const missing = jobs.filter(job => !job.description?.trim());
    if (missing.length === 0) return jobs;
    const hydrated = await attachJobDescriptions(getSupabaseAdmin(), missing, jobsTableForCountry(catalogCountry));
    const byId = new Map(hydrated.map(job => [job.id, job.description]));
    return jobs.map(job => byId.get(job.id) ? { ...job, description: byId.get(job.id)! } : job);
}

export interface GetCompaniesParams {
    page?: number;
    q?: string;
    sort?: string;
    excludedCompanyIds?: number[];
    userSectors?: string[];
    catalogCountry?: JobsCatalogCountry;
}

// ---------------------------------------------------------------------------
// Public Preview Feed (unauthenticated)
// ---------------------------------------------------------------------------

const PUBLIC_PREVIEW_MAX_PER_COMPANY = 2;
/**
 * Candidate pool for the per-company cap. Preferences are required on the public
 * page, so tiers are already filtered; 60 rows keeps cold builds fast while still
 * letting the cap spread jobs across employers.
 * Deliberately not the per-user shuffled feed: each new preference set would
 * trigger a cold full-catalog order build, which anonymous traffic must not drive.
 */
const PUBLIC_PREVIEW_POOL_SIZE = 60;

/** Keep feed order but cap jobs per company; backfill from overflow if the pool is thin. */
function pickDiversePreviewJobs(jobs: JobsPortalJob[], limit: number, maxPerCompany: number): JobsPortalJob[] {
    const picked: JobsPortalJob[] = [];
    const overflow: JobsPortalJob[] = [];
    const perCompany = new Map<number, number>();
    for (const job of jobs) {
        if (picked.length >= limit) break;
        const count = perCompany.get(job.company_id) ?? 0;
        if (count < maxPerCompany) {
            perCompany.set(job.company_id, count + 1);
            picked.push(job);
        } else {
            overflow.push(job);
        }
    }
    return [...picked, ...overflow].slice(0, limit);
}

export interface PublicPreviewFeedParams {
    sectors: string[];
    experienceLevels: string[];
    jobTypes: string[];
    catalogCountry: JobsCatalogCountry;
}

/**
 * Deterministic browse slice for logged-out visitors: same preferences always
 * return the same jobs (no per-request shuffle, no userId seed), so refreshing
 * cannot enumerate the catalog. Caller applies the anon projection.
 */
export async function getPublicPreviewFeed(
    params: PublicPreviewFeedParams,
    limit: number
): Promise<{ jobs: JobsPortalJob[]; totalCount: number }> {
    const db = getSupabaseAdmin();
    const jobsTable = jobsTableForCountry(params.catalogCountry);

    const userSectors = sanitizeUserSectors(params.sectors);
    const userExperienceLevels = sanitizeUserExperienceLevels(params.experienceLevels);
    const userJobTypes = sanitizeUserJobTypes(params.jobTypes);
    const jobLevels = userExperienceLevels.length
        ? expandUserLevelsToJobLevels(userExperienceLevels)
        : null;

    const browse = await loadBrowseFeed(db, {
        page: 1,
        limit: PUBLIC_PREVIEW_POOL_SIZE,
        userSectors,
        userExperienceLevels,
        userJobTypes,
        sectors: userSectors.length ? userSectors : null,
        jobLevels: jobLevels?.length ? jobLevels : null,
        jobTypes: userJobTypes.length ? userJobTypes : null,
        catalogCountry: params.catalogCountry,
        jobsTable,
    });

    const candidates = toPublicPortalJobs(
        browse.jobs.filter((job) => !isLowProfilePortalJob(job)) as unknown[]
    );
    const visible = pickDiversePreviewJobs(candidates, limit, PUBLIC_PREVIEW_MAX_PER_COMPANY);
    return { jobs: visible, totalCount: browse.totalCount };
}

// ---------------------------------------------------------------------------
// Jobs Feed Service
// ---------------------------------------------------------------------------

export {
    resolveUserBrowseSectors,
    resolveUserBrowseExperienceLevels,
} from './userPreferences';

async function loadBrowseFeed(
    db: SupabaseClient,
    params: {
        page: number;
        limit: number;
        maxJobsReturned?: number;
        userId?: string;
        userSectors: Sector[];
        userExperienceLevels: string[];
        userJobTypes: string[];
        sectors: Sector[] | null;
        jobLevels: string[] | null;
        jobTypes: string[] | null;
        excludedJobIds?: string[];
        excludedCompanyIds?: number[];
        companyId?: number;
        catalogCountry: JobsCatalogCountry;
        jobsTable: import('./jobsCatalog').JobsTableName;
    }
): Promise<TwoPhaseBrowseResult> {
    const browseFilterOpts = {
        excludedJobIds: params.excludedJobIds,
        excludedCompanyIds: params.excludedCompanyIds,
        companyId: params.companyId,
    };
    const browseParams = {
        page: params.page,
        limit: params.limit,
        maxJobsReturned: params.maxJobsReturned,
        sectors: params.sectors,
        jobLevels: params.jobLevels,
        jobTypes: params.jobTypes,
        jobsTable: params.jobsTable,
        catalogCountry: params.catalogCountry,
        ...browseFilterOpts,
    };

    const shuffleSeed = params.userId
        ? deriveFeedShuffleSeed(
              params.userId,
              params.userSectors,
              params.userExperienceLevels,
              params.catalogCountry,
              params.userJobTypes
          )
        : undefined;

    if (shuffleSeed && !requiresFreshUkFeed(params.catalogCountry)) {
        return fetchShuffledBrowseFeed(db, { ...browseParams, shuffleSeed });
    }
    if (params.sectors?.length || params.jobLevels?.length || params.jobTypes?.length) {
        return fetchTwoPhaseBrowseFeed(db, browseParams);
    }
    return fetchSinglePhaseBrowseFeed(db, {
        ...browseParams,
        sectors: null,
        jobLevels: null,
        jobTypes: null,
    });
}

const COMPANY_NAME_LEADING_STOPWORDS = new Set(['the', 'a', 'an']);

/** Only treat a company as a name-match if the query hits its leading brand word. */
export function companyNameLeadMatches(tradingName: string, qTerm: string): boolean {
    const words = tradingName.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && COMPANY_NAME_LEADING_STOPWORDS.has(words[i])) i++;
    const lead = words[i];
    if (!lead) return false;
    return lead.startsWith(qTerm) || qTerm.startsWith(lead);
}

export async function getJobsFeed(params: GetJobsParams): Promise<JobsFeedResult> {
    const db = getSupabaseAdmin();

    const page = Math.max(1, params.page || 1);
    const limit = JOBS_PAGE_SIZE;
    const catalogCountry = params.catalogCountry ?? 'uk';
    const jobsTable = jobsTableForCountry(catalogCountry);

    const globalCountPromise = getCachedGlobalJobCount(async () => {
        const { count } = await db.from(jobsTable).select('id', { count: 'exact', head: true });
        return count || 0;
    }, catalogCountry);

    const userSectors = sanitizeUserSectors(params.userSectors);
    const userExperienceLevels = sanitizeUserExperienceLevels(params.userExperienceLevels);
    const userJobTypes = sanitizeUserJobTypes(params.userJobTypes);

    const roleTerm = normalizeSearchTerm(params.role || '');
    const whereTerm = normalizeSearchTerm(params.where || '');
    // Legacy: empty role + q → treat q as role
    const legacyQ = normalizeSearchTerm(params.q || '');
    const effectiveRole = roleTerm || legacyQ;
    const isSearch = Boolean(effectiveRole || whereTerm);

    const sectors = userSectors.length > 0 ? userSectors : null;
    const jobLevels =
        userExperienceLevels.length > 0
            ? expandUserLevelsToJobLevels(userExperienceLevels)
            : null;
    const jobTypes = userJobTypes.length > 0 ? userJobTypes : null;
    const hasBrowsePreferences = Boolean(
        !isSearch && (sectors?.length || jobLevels?.length || jobTypes?.length)
    );

    const browseFilterOpts = {
        excludedJobIds: params.excludedJobIds,
        excludedCompanyIds: params.excludedCompanyIds,
        companyId: params.companyId,
    };

    let pagedJobs: JobsPortalJob[];
    let totalCount: number;
    let preferredTotalCount: number | undefined;
    let secondaryTotalCount: number | undefined;
    let levelOnlyTotalCount: number | undefined;
    let remainderTotalCount: number | undefined;
    let browseHasSectorPreferences: boolean | undefined;
    let browseHasLevelPreferences: boolean | undefined;
    let browseHasJobTypePreferences: boolean | undefined;
    let catalogJobLevels: readonly string[] | undefined;
    let matchedJobLevels: string[] | undefined;
    let matchedJobTypes: string[] | undefined;

    if (isSearch) {
        // Company prefetch for `where` only — leading brand-word filter (Bug 2).
        const matchingCompanyIds = whereTerm
            ? await (async () => {
                  try {
                      const safeWhere = whereTerm.replace(/,/g, ' ');
                      const { data } = await db
                          .from('companies')
                          .select('id, trading_name, companies_house_name')
                          .or(
                              `trading_name.ilike.%${safeWhere}%,companies_house_name.ilike.%${safeWhere}%`
                          )
                          .limit(JOBS_COMPANY_NAME_SEARCH_LIMIT);
                      return ((data || []) as {
                          id: number;
                          trading_name: string;
                          companies_house_name: string | null;
                      }[])
                          .filter(
                              (r) =>
                                  companyNameLeadMatches(r.trading_name || '', whereTerm) ||
                                  companyNameLeadMatches(r.companies_house_name || '', whereTerm)
                          )
                          .map((r) => r.id);
                  } catch {
                      return [];
                  }
              })()
            : [];

        // Hard match on role/where; soft-rank matches by all prefs (including sector).
        const search = await fetchShuffledSearchFeed(db, {
            page,
            limit,
            maxJobsReturned: params.maxJobsReturned,
            roleTerm: effectiveRole,
            whereTerm,
            matchingCompanyIds,
            jobsTable,
            catalogCountry,
            sectors,
            jobLevels,
            jobTypes,
            ...browseFilterOpts,
        });
        pagedJobs = search.jobs
            .map(({ feedSegment: _segment, ...job }) => job)
            .filter((job) => !isLowProfilePortalJob(job));
        totalCount = search.totalCount;
    } else {
        const browse = await loadBrowseFeed(db, {
            page,
            limit,
            maxJobsReturned: params.maxJobsReturned,
            userId: params.userId,
            userSectors,
            userExperienceLevels,
            userJobTypes,
            sectors: hasBrowsePreferences ? sectors : null,
            jobLevels: jobLevels?.length ? jobLevels : null,
            jobTypes: jobTypes?.length ? jobTypes : null,
            catalogCountry,
            jobsTable,
            ...browseFilterOpts,
        });

        pagedJobs = browse.jobs.filter((job) => !isLowProfilePortalJob(job));
        totalCount = browse.totalCount;
        preferredTotalCount = browse.preferredTotalCount;
        secondaryTotalCount = browse.secondaryTotalCount;
        levelOnlyTotalCount = browse.levelOnlyTotalCount;
        remainderTotalCount = browse.remainderTotalCount;
        browseHasSectorPreferences = browse.browseHasSectorPreferences;
        browseHasLevelPreferences = browse.browseHasLevelPreferences;
        catalogJobLevels = browse.catalogJobLevels ?? JOB_CATALOG_LEVELS;
        matchedJobLevels = browse.matchedJobLevels ?? [];
        matchedJobTypes = jobTypes ?? [];
        browseHasJobTypePreferences = Boolean(jobTypes?.length);
    }

    const totalPages = Math.max(1, Math.ceil(totalCount / limit));

    // If userId is provided, check which jobs have been reported by this user in Supabase
    if (params.userId && pagedJobs.length > 0) {
        try {
            const jobIds = pagedJobs.map(j => String(j.id));
            
            const { data: reports, error } = await db.from('job_reports')
                .select('job_id')
                .eq('user_id', params.userId)
                .in('job_id', jobIds);

            if (error) throw error;

            const reportedJobIds = new Set((reports || []).map(doc => String(doc.job_id)));
            
            pagedJobs = pagedJobs.map(j => ({
                ...j,
                hasReported: reportedJobIds.has(String(j.id))
            }));
        } catch (err) {
            console.error('[jobsPortalService] Error checking reported jobs in Supabase:', err);
            // Non-blocking: continue without reporting status if Supabase fails
        }
    }

    const globalTotalCount = await globalCountPromise;

    const publicJobs = toPublicPortalJobs(pagedJobs as unknown[]);
    const cappedJobs =
        params.maxJobsReturned !== undefined
            ? publicJobs.slice(0, params.maxJobsReturned)
            : publicJobs;
    const jobs = cappedJobs;

    return {
        jobs,
        totalPages,
        totalCount,
        globalTotalCount: globalTotalCount || 0,
        catalogCountry,
        ...(preferredTotalCount !== undefined ? { preferredTotalCount } : {}),
        ...(secondaryTotalCount !== undefined ? { secondaryTotalCount } : {}),
        ...(levelOnlyTotalCount !== undefined ? { levelOnlyTotalCount } : {}),
        ...(remainderTotalCount !== undefined ? { remainderTotalCount } : {}),
        ...(browseHasSectorPreferences !== undefined ? { browseHasSectorPreferences } : {}),
        ...(browseHasLevelPreferences !== undefined ? { browseHasLevelPreferences } : {}),
        ...(browseHasJobTypePreferences !== undefined ? { browseHasJobTypePreferences } : {}),
        ...(catalogJobLevels !== undefined ? { catalogJobLevels } : {}),
        ...(matchedJobLevels !== undefined ? { matchedJobLevels } : {}),
        ...(matchedJobTypes !== undefined ? { matchedJobTypes } : {}),
    };
}

// ---------------------------------------------------------------------------
// Report Job
// ---------------------------------------------------------------------------

export async function reportJobListing(
    userId: string,
    email: string | undefined,
    jobId: string,
    jobTitle?: string,
    companyName?: string,
    reason?: string
): Promise<{ success: boolean; message: string; error?: string; status?: number }> {
    const db = getSupabaseAdmin();

    if (!userId) {
        return { success: false, message: 'Unauthorized', error: 'User ID is required.', status: 401 };
    }

    try {
        const { data: existing, error: fetchError } = await db.from('job_reports')
            .select('id')
            .eq('user_id', userId)
            .eq('job_id', jobId)
            .maybeSingle();

        if (fetchError) throw fetchError;

        if (existing) {
            return { 
                success: false, 
                message: 'Already reported', 
                error: 'You have already reported this job.',
                status: 400 
            };
        }

        const { error: insertError } = await db.from('job_reports').insert({
            job_id: jobId,
            job_title: jobTitle || null,
            company_name: companyName || null,
            user_id: userId,
            user_email: email || null,
            reason: reason || null,
            reported_at: new Date().toISOString()
        });

        if (insertError) throw insertError;

        return { success: true, message: 'Job reported successfully' };
    } catch (err: any) {
        console.error('[jobsPortalService] reportJobListing error:', err);
        return { 
            success: false, 
            message: 'Failed to submit report', 
            error: err.message || 'Unknown error',
            status: 500
        };
    }
}

// ---------------------------------------------------------------------------
// Companies Directory
// ---------------------------------------------------------------------------

export async function getCompaniesList(params: GetCompaniesParams) {
    return listPortalCompanies({
        catalogCountry: params.catalogCountry ?? 'uk',
        page: params.page,
        q: params.q,
    });
}

// ---------------------------------------------------------------------------
// Sponsorship Data — in-memory cache with server-side search and pagination
// ---------------------------------------------------------------------------

const CSV_CANDIDATES = [
    path.resolve(__dirname, '../../data/workers.csv'),  // dist/jobs-portal → ProductBackend/data
    path.resolve(__dirname, '../data/workers.csv'),     // jobs-portal/ (ts-node)
    path.resolve(process.cwd(), 'data/workers.csv'),   // cwd fallback
];

interface SponsorCompanyRecord {
    organisationName: string;
    townCity: string;
    /** Register column 3; used by the chat agent's sponsor search. */
    county: string;
    typeRating: string;
    route: string;
    _nameLower: string;
    _cityLower: string;
}

interface SponsorshipStats {
    total: number;
    cityCounts: Array<{ city: string; count: number }>;
}

interface SponsorshipCache {
    all: SponsorCompanyRecord[];
    stats: SponsorshipStats;
}

export function normalizeSponsorshipCityFilter(raw: string | undefined): string[] | undefined {
    if (raw == null) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const cities = trimmed.split(',').map((c) => c.trim()).filter(Boolean);
    return cities.length > 0 ? cities : undefined;
}

export function normalizeSponsorshipSearchQuery(raw: string | undefined): string | undefined {
    if (raw == null) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (trimmed.length > SPONSORSHIP_SEARCH_MAX_LENGTH) {
        throw new Error(`Search query must be ${SPONSORSHIP_SEARCH_MAX_LENGTH} characters or less`);
    }
    return trimmed;
}

export interface SponsorshipQueryResult {
    companies: Array<{
        organisationName: string;
        townCity: string;
        typeRating: string;
        route: string;
    }>;
    page: number;
    totalPages: number;
    totalCount: number;
    stats: SponsorshipStats;
}

let _sponsorshipCache: SponsorshipCache | null = null;
let _cacheBuildPromise: Promise<SponsorshipCache> | null = null;

export function invalidateSponsorshipCache(): void {
    _sponsorshipCache = null;
    _cacheBuildPromise = null;
}

// RFC 4180 CSV line parser — handles quoted fields and "" escaped quotes
function parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let i = 0;

    while (i < line.length) {
        if (line[i] === '"') {
            let field = '';
            i++; // skip opening quote
            while (i < line.length) {
                if (line[i] === '"') {
                    if (i + 1 < line.length && line[i + 1] === '"') {
                        field += '"';
                        i += 2; // skip escaped quote pair
                    } else {
                        i++; // skip closing quote
                        break;
                    }
                } else {
                    field += line[i++];
                }
            }
            fields.push(field);
        } else {
            const start = i;
            while (i < line.length && line[i] !== ',') i++;
            fields.push(line.slice(start, i));
        }

        if (i < line.length && line[i] === ',') {
            i++;
            if (i === line.length) fields.push(''); // trailing empty field
        }
    }

    return fields;
}

async function buildSponsorshipCache(): Promise<SponsorshipCache> {
    let csvPath: string | null = null;
    for (const candidate of CSV_CANDIDATES) {
        try {
            await fs.promises.access(candidate);
            csvPath = candidate;
            break;
        } catch { /* try next */ }
    }

    if (!csvPath) {
        throw new Error(`workers.csv not found in: ${CSV_CANDIDATES.join(', ')}`);
    }

    console.log(`[sponsorship] Loading CSV from ${csvPath}`);
    const text = await fs.promises.readFile(csvPath, 'utf-8');

    // Strip UTF-8 BOM if present
    const cleaned = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const lines = cleaned.split('\n');

    const all: SponsorCompanyRecord[] = [];
    const cityCountMap = new Map<string, { label: string; count: number }>();

    // Line 0 is the header; parse from line 1
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        if (!line.trim()) continue;

        const fields = parseCSVLine(line);
        // CSV columns: [0] Organisation Name  [1] Town/City  [2] County  [3] Type & Rating  [4] Route
        const orgName = (fields[0] ?? '').trim();
        if (!orgName) continue;

        const townCity = (fields[1] ?? '').trim();
        if (townCity) {
            const cityKey = townCity.toLowerCase();
            const existing = cityCountMap.get(cityKey);
            if (existing) {
                existing.count += 1;
                if (townCity !== townCity.toUpperCase() && existing.label === existing.label.toUpperCase()) {
                    existing.label = townCity;
                }
            } else {
                cityCountMap.set(cityKey, { label: townCity, count: 1 });
            }
        }
        all.push({
            organisationName: orgName,
            townCity,
            county: (fields[2] ?? '').trim(),
            typeRating: (fields[3] ?? '').trim(),
            route: (fields[4] ?? '').trim(),
            _nameLower: orgName.toLowerCase(),
            _cityLower: townCity.toLowerCase(),
        });
    }

    const total = all.length;
    const cityCounts = [...cityCountMap.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 50)
        .map(({ label, count }) => ({ city: label, count }));

    console.log(`[sponsorship] Cache built: ${total} records`);

    return {
        all,
        stats: { total, cityCounts },
    };
}

async function getSponsorshipCache(): Promise<SponsorshipCache> {
    if (_sponsorshipCache) return _sponsorshipCache;

    // Serialize concurrent cold-start requests — only one file read ever fires
    if (!_cacheBuildPromise) {
        _cacheBuildPromise = buildSponsorshipCache()
            .then(cache => {
                _sponsorshipCache = cache;
                _cacheBuildPromise = null;
                return cache;
            })
            .catch(err => {
                _cacheBuildPromise = null; // allow retry on next request
                throw err;
            });
    }

    return _cacheBuildPromise;
}

/** Pre-load workers.csv into memory (cron / post-deploy warm-up). */
export async function warmSponsorshipCache(force = false): Promise<{
    total: number;
    durationMs: number;
}> {
    if (force) invalidateSponsorshipCache();
    const started = Date.now();
    const cache = await getSponsorshipCache();
    return {
        total: cache.stats.total,
        durationMs: Date.now() - started,
    };
}

export async function listUkSponsorshipRegister(): Promise<
    Array<{ organisationName: string; townCity: string; county: string; typeRating: string; route: string }>
> {
    const cache = await getSponsorshipCache();
    return cache.all.map(({ organisationName, townCity, county, typeRating, route }) => ({
        organisationName,
        townCity,
        county,
        typeRating,
        route,
    }));
}

export async function querySponsorshipData(
    page: number,
    q: string | undefined,
    cities: string[] | undefined
): Promise<SponsorshipQueryResult> {
    const cache = await getSponsorshipCache();

    const query = q?.trim().toLowerCase();
    const citySet = cities ? new Set(cities.map((c) => c.toLowerCase())) : null;

    const source = cache.all.filter((c) => {
        if (query && !c._nameLower.includes(query) && !c._cityLower.includes(query)) {
            return false;
        }
        if (citySet && citySet.size > 0 && !citySet.has(c._cityLower)) {
            return false;
        }
        return true;
    });

    const totalCount = source.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / SPONSORSHIP_PAGE_SIZE));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const offset = (safePage - 1) * SPONSORSHIP_PAGE_SIZE;

    return {
        companies: source.slice(offset, offset + SPONSORSHIP_PAGE_SIZE).map(
            ({ organisationName, townCity, typeRating, route }) => ({
                organisationName, townCity, typeRating, route,
            })
        ),
        page: safePage,
        totalPages,
        totalCount,
        stats: cache.stats,
    };
}
export {
    getUserPreferences,
    saveUserPreferences,
    getCareerBrowsePreferences,
    saveCareerBrowsePreferences,
} from './userPreferences';

export { bumpJobsCatalogVersion, invalidateJobsCatalogCaches } from './feedOrderCache';
