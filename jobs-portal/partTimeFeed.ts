/**
 * UK part-time job feed. Reads part_time_jobs_UK only.
 * Employers come from companies (company_id) or part_time_companies_UK
 * (part_time_company_id). No preference ranking and no Ireland catalog.
 * Browse order is a deterministic per-user shuffle (stable across pages). Role
 * search ranks by relevance tier (see partTimeSearch.ts) and shuffles within a
 * tier. Order is cached in Upstash Redis when configured (rebuilt on miss).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
    JOBS_COMPANY_NAME_SEARCH_LIMIT,
    JOBS_PAGE_SIZE,
    JOBS_SEARCH_QUERY_MAX_LENGTH,
} from './constants';
import { derivePartTimeShuffleSeed, normalizeSearchTerm } from './feedSeed';
import { getJobsCatalogVersion } from './feedOrderCache';
import { sortIdsBySeed } from './feedShuffle';
import {
    buildPartTimeFeedOrderCacheKey,
    getCachedPartTimeFeedOrder,
    PART_TIME_SEARCH_ORDER_TTL_SECONDS,
    setCachedPartTimeFeedOrder,
} from './partTimeFeedOrderCache';
import {
    createPartTimeRoleRanker,
    parsePartTimeRoleQuery,
    partTimeRoleFingerprint,
    partTimeRoleTermFilter,
    type PartTimeRoleQuery,
} from './partTimeSearch';
import {
    cleanPortalJobLocation,
    toPublicPortalCompany,
    toPublicPortalJob,
} from './publicResponse';
import type { JobsPortalJob, PublicJobsPortalCompany } from './types';

export const PART_TIME_JOBS_TABLE = 'part_time_jobs_UK';
export const PART_TIME_COMPANIES_TABLE = 'part_time_companies_UK';
export const PART_TIME_REPORT_PREFIX = 'ptuk:';

const LIST_COLUMNS =
    'id, title, url, location, city, nation, department, level, sector, job_type, created_at, company_id, part_time_company_id';

const COMPANY_BATCH_SIZE = 500;
const ID_FETCH_BATCH = 1000;

const GLOBAL_COUNT_TTL_MS = 60_000;
const STORED_CITIES_TTL_MS = 5 * 60_000;
const PLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9 .&'-]{0,80}$/;

let supabaseAdmin: SupabaseClient | null = null;
let cachedGlobalCount: { value: number; at: number } | null = null;
let cachedStoredCities: { values: string[]; at: number } | null = null;

function getSupabaseAdmin(): SupabaseClient {
    if (supabaseAdmin) return supabaseAdmin;

    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) {
        throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
    }

    supabaseAdmin = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    return supabaseAdmin;
}

export function toPartTimeReportId(jobId: string | number): string {
    const raw = String(jobId).trim();
    if (raw.startsWith(PART_TIME_REPORT_PREFIX)) return raw;
    return `${PART_TIME_REPORT_PREFIX}${raw}`;
}

export function parsePartTimeJobId(raw: string): string | null {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    return trimmed;
}

/**
 * Only treat a company as a name-match if the query hits its leading brand word.
 * `typed` is the query without apostrophes; `core` also drops a possessive "s",
 * which must then match the whole brand word ("boots" ≠ "Booths").
 */
function companyNameLeadMatches(tradingName: string, typed: string, core: string): boolean {
    const stopwords = new Set(['the', 'a', 'an']);
    const words = stripApostrophes(tradingName.trim().toLowerCase()).split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && stopwords.has(words[i]!)) i++;
    const lead = words[i];
    if (!lead) return false;
    if (lead.startsWith(typed) || typed.startsWith(lead)) return true;
    return lead === core || lead === `${core}s`;
}

function stripApostrophes(value: string): string {
    return value.replace(/['‘’`]/g, '');
}

/**
 * Brand core for company search: "Sainsbury's" / "sainsburys" → "sainsbury",
 * "GAIL's" → "gail". Matches with or without the apostrophe in the stored name.
 */
function companySearchCore(term: string): string {
    const words = stripApostrophes(term.toLowerCase()).trim().split(/\s+/).filter(Boolean);
    const last = words[words.length - 1];
    if (last && last.length > 4 && last.endsWith('s') && !last.endsWith('ss')) {
        words[words.length - 1] = last.slice(0, -1);
    }
    return words.join(' ');
}

function ilikeTerm(term: string): string {
    return term
        .replace(/[%_,.()"'\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, JOBS_SEARCH_QUERY_MAX_LENGTH);
}

function ilikeClause(column: string, term: string): string {
    return `${column}.ilike.%${term}%`;
}

function inClause(column: string, ids: string[]): string {
    const safe = ids.filter((id) => /^[\w-]+$/.test(id));
    if (safe.length === 0) return '';
    return `${column}.in.("${safe.join('","')}")`;
}

export function isSafePartTimePlaceName(value: string): boolean {
    return PLACE_NAME.test(value);
}

/** Distinct city values stored on part-time jobs. Cached so repeat visits do not rescan the table. */
export async function listStoredPartTimeCities(): Promise<string[]> {
    const now = Date.now();
    if (cachedStoredCities && now - cachedStoredCities.at < STORED_CITIES_TTL_MS) {
        return cachedStoredCities.values;
    }

    const db = getSupabaseAdmin();
    const found = new Set<string>();
    const pageSize = 1000;
    let from = 0;
    for (;;) {
        const { data, error } = await db
            .from(PART_TIME_JOBS_TABLE)
            .select('city')
            .not('city', 'is', null)
            .neq('city', '')
            .range(from, from + pageSize - 1);
        if (error) {
            console.error('[partTimeFeed] stored cities error:', error.message);
            return cachedStoredCities?.values ?? [];
        }
        if (!data?.length) break;
        for (const row of data) {
            const city = typeof row.city === 'string' ? row.city.trim() : '';
            if (city && isSafePartTimePlaceName(city)) found.add(city);
        }
        if (data.length < pageSize) break;
        from += pageSize;
    }

    const values = [...found].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    cachedStoredCities = { values, at: now };
    return values;
}

/** City column, or a blank city whose location is that place or starts with it. */
function partTimePlaceClause(place: string): string {
    const exact = `"${place.replace(/"/g, '')}"`;
    const afterComma = `"${place.replace(/"/g, '')},%"`;
    const afterPipe = `"${place.replace(/"/g, '')} |%"`;
    return `city.eq.${exact},location.eq.${exact},location.ilike.${afterComma},location.ilike.${afterPipe}`;
}

function locationLabel(row: Record<string, unknown>): string {
    const location = cleanPortalJobLocation(row.location);
    if (location) return location;
    const city = typeof row.city === 'string' ? row.city.trim() : '';
    if (city) return city;
    const nation = typeof row.nation === 'string' ? row.nation.trim() : '';
    if (nation) return nation;
    return 'United Kingdom';
}

const PART_TIME_COMPANY_COLUMNS =
    'id, trading_name, url, careers_url, url_favicon, url_linkedin, description, estimated_num_employees_label';

const SPONSOR_COMPANY_COLUMNS =
    'id, trading_name, companies_house_name, url, careers_url, url_linkedin, url_favicon, description, estimated_num_employees_label, licensed_sponsor, ireland_permit_employer, cos_used_count_2025, open_to_sponsorship, show_recently_added_badge, added_to_register';

async function selectSponsorCompanies(
    db: SupabaseClient,
    ids: string[],
): Promise<Record<string, unknown>[]> {
    if (ids.length === 0) return [];
    let columns = SPONSOR_COMPANY_COLUMNS;
    let rows = await selectByIds(db, 'companies', columns, ids);
    if (rows.length > 0 || ids.length === 0) return rows;

    const { error } = await db.from('companies').select(columns).limit(1);
    if (!error) return rows;
    if (/ireland_permit_employer/i.test(error.message)) {
        columns = columns
            .split(', ')
            .filter((col) => col !== 'ireland_permit_employer')
            .join(', ');
    }
    if (/careers_url/i.test(error.message)) {
        columns = columns
            .split(', ')
            .filter((col) => col !== 'careers_url')
            .join(', ');
    }
    if (columns === SPONSOR_COMPANY_COLUMNS) return rows;
    return selectByIds(db, 'companies', columns, ids);
}

async function selectByIds(
    db: SupabaseClient,
    table: string,
    columns: string,
    ids: string[],
): Promise<Record<string, unknown>[]> {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < unique.length; i += COMPANY_BATCH_SIZE) {
        const batch = unique.slice(i, i + COMPANY_BATCH_SIZE);
        const { data, error } = await db.from(table).select(columns).in('id', batch);
        if (error) {
            console.error(`[partTimeFeed] ${table} fetch error:`, error.message);
            continue;
        }
        rows.push(...(((data as unknown) as Record<string, unknown>[] | null) || []));
    }
    return rows;
}

async function hydratePartTimeJobs(
    db: SupabaseClient,
    rows: Record<string, unknown>[],
): Promise<JobsPortalJob[]> {
    if (rows.length === 0) return [];

    const companyIds = rows
        .map((row) => (row.company_id == null ? '' : String(row.company_id).trim()))
        .filter(Boolean);
    const partTimeCompanyIds = rows
        .map((row) =>
            row.part_time_company_id == null ? '' : String(row.part_time_company_id).trim(),
        )
        .filter(Boolean);

    const [sponsorRows, catalogRows] = await Promise.all([
        selectSponsorCompanies(db, companyIds),
        selectByIds(db, PART_TIME_COMPANIES_TABLE, PART_TIME_COMPANY_COLUMNS, partTimeCompanyIds),
    ]);

    const sponsors = new Map<string, PublicJobsPortalCompany>();
    for (const row of sponsorRows) {
        const company = toPublicPortalCompany(row);
        sponsors.set(String(row.id), company);
    }
    const catalogs = new Map<string, PublicJobsPortalCompany>();
    for (const row of catalogRows) {
        catalogs.set(String(row.id), toPublicPortalCompany(row));
    }

    return rows.map((row) => {
        const sponsor = sponsors.get(String(row.company_id ?? ''));
        const catalog = catalogs.get(String(row.part_time_company_id ?? ''));
        const company = sponsor ?? catalog;
        const city = typeof row.city === 'string' ? row.city.trim() : '';
        return toPublicPortalJob({
            ...row,
            location: locationLabel(row),
            ...(city ? { city } : {}),
            company_id: company?.id ?? row.company_id,
            ...(company ? { company } : {}),
        });
    });
}

async function matchingEmployerIds(
    db: SupabaseClient,
    rawTerm: string,
): Promise<{ companyIds: string[]; partTimeCompanyIds: string[] }> {
    const typed = stripApostrophes(rawTerm.toLowerCase()).trim();
    const whereTerm = companySearchCore(rawTerm);
    const safeWhere = ilikeTerm(whereTerm);
    if (!safeWhere) return { companyIds: [], partTimeCompanyIds: [] };

    const [companiesResult, catalogResult] = await Promise.all([
        db
            .from('companies')
            .select('id, trading_name, companies_house_name')
            .or(
                `${ilikeClause('trading_name', safeWhere)},${ilikeClause('companies_house_name', safeWhere)}`,
            )
            .limit(JOBS_COMPANY_NAME_SEARCH_LIMIT),
        db
            .from(PART_TIME_COMPANIES_TABLE)
            .select('id, trading_name')
            .ilike('trading_name', `%${safeWhere}%`)
            .limit(JOBS_COMPANY_NAME_SEARCH_LIMIT),
    ]);

    const companyIds: string[] = [];
    if (!companiesResult.error) {
        for (const row of (companiesResult.data || []) as Array<{
            id: string | number;
            trading_name?: string | null;
            companies_house_name?: string | null;
        }>) {
            const name = row.trading_name || '';
            const legal = row.companies_house_name || '';
            if (
                companyNameLeadMatches(name, typed, whereTerm) ||
                companyNameLeadMatches(legal, typed, whereTerm)
            ) {
                companyIds.push(String(row.id));
            }
        }
    } else {
        console.error('[partTimeFeed] company name search error:', companiesResult.error.message);
    }

    const partTimeCompanyIds: string[] = [];
    if (!catalogResult.error) {
        for (const row of (catalogResult.data || []) as Array<{
            id: string | number;
            trading_name?: string | null;
        }>) {
            if (companyNameLeadMatches(row.trading_name || '', typed, whereTerm)) {
                partTimeCompanyIds.push(String(row.id));
            }
        }
    } else {
        console.error('[partTimeFeed] part-time company search error:', catalogResult.error.message);
    }

    return { companyIds, partTimeCompanyIds };
}

async function globalJobCount(db: SupabaseClient): Promise<number> {
    const now = Date.now();
    if (cachedGlobalCount && now - cachedGlobalCount.at < GLOBAL_COUNT_TTL_MS) {
        return cachedGlobalCount.value;
    }
    const { count, error } = await db
        .from(PART_TIME_JOBS_TABLE)
        .select('id', { count: 'exact', head: true });
    if (error) {
        console.error('[partTimeFeed] global count error:', error.message);
        return cachedGlobalCount?.value ?? 0;
    }
    const value = count || 0;
    cachedGlobalCount = { value, at: now };
    return value;
}

async function attachReportedFlags(
    db: SupabaseClient,
    jobs: JobsPortalJob[],
    userId: string | undefined,
): Promise<JobsPortalJob[]> {
    if (!userId || jobs.length === 0) return jobs;
    const reportIds = jobs.map((job) => toPartTimeReportId(job.id));
    const { data, error } = await db
        .from('job_reports')
        .select('job_id')
        .eq('user_id', userId)
        .in('job_id', reportIds);
    if (error) {
        console.error('[partTimeFeed] report lookup error:', error.message);
        return jobs;
    }
    const reported = new Set((data || []).map((row) => String(row.job_id)));
    return jobs.map((job) =>
        reported.has(toPartTimeReportId(job.id)) ? { ...job, hasReported: true } : job,
    );
}

async function attachDescriptions(
    db: SupabaseClient,
    jobs: JobsPortalJob[],
): Promise<JobsPortalJob[]> {
    if (jobs.length === 0) return jobs;
    const ids = jobs.map((job) => job.id).filter(Boolean);
    const { data, error } = await db
        .from(PART_TIME_JOBS_TABLE)
        .select('id, description')
        .in('id', ids);
    if (error) {
        console.error('[partTimeFeed] description fetch error:', error.message);
        return jobs;
    }
    const byId = new Map<string, string>();
    for (const row of ((data as unknown) as Array<{ id?: unknown; description?: unknown }> | null) || []) {
        const id = String(row.id ?? '');
        const text = typeof row.description === 'string' ? row.description.trim() : '';
        if (id && text) byId.set(id, text);
    }
    return jobs.map((job) => {
        const description = byId.get(String(job.id));
        return description ? { ...job, description } : job;
    });
}

/** Chat calls this only after the user's part-time entitlement and result cap have been applied. */
export async function attachPartTimeChatJobDescriptions(jobs: JobsPortalJob[]): Promise<JobsPortalJob[]> {
    if (jobs.length > JOBS_PAGE_SIZE) throw new Error('Chat description hydration exceeds page size');
    const missing = jobs.filter(job => !job.description?.trim());
    if (missing.length === 0) return jobs;
    const hydrated = await attachDescriptions(getSupabaseAdmin(), missing);
    const byId = new Map(hydrated.map(job => [job.id, job.description]));
    return jobs.map(job => byId.get(job.id) ? { ...job, description: byId.get(job.id)! } : job);
}

export interface PartTimeJobsFeedResult {
    jobs: JobsPortalJob[];
    totalPages: number;
    totalCount: number;
    globalTotalCount: number;
}

type PartTimeFilterOpts = {
    roleQuery: PartTimeRoleQuery;
    /** Company box text. Location comes only from the city dropdown. */
    companyIlike: string;
    city?: string;
    companyIds: string[];
    partTimeCompanyIds: string[];
};

function applyPartTimeFilters<T extends { or: (v: string) => T }>(
    query: T,
    opts: PartTimeFilterOpts,
): T {
    let next = query;
    // One `or` per term: chained filters are ANDed, so every term must match.
    for (const term of opts.roleQuery.terms) {
        const filter = partTimeRoleTermFilter(term);
        if (filter) next = next.or(filter);
    }
    if (opts.companyIlike) {
        const clauses = [
            inClause('company_id', opts.companyIds),
            inClause('part_time_company_id', opts.partTimeCompanyIds),
        ].filter(Boolean);
        // Callers skip the query when no employer matched, so clauses is never empty here.
        next = next.or(clauses.join(','));
    }
    if (opts.city) {
        next = next.or(partTimePlaceClause(opts.city));
    }
    return next;
}

function partTimeFilterFingerprint(opts: PartTimeFilterOpts): string {
    return [
        partTimeRoleFingerprint(opts.roleQuery),
        opts.companyIlike,
        opts.city || '',
        opts.companyIds.slice().sort().join(','),
        opts.partTimeCompanyIds.slice().sort().join(','),
    ].join('|');
}

type MatchingPartTimeRow = { id: string | number; title?: string | null };

async function fetchMatchingPartTimeRows(
    db: SupabaseClient,
    opts: PartTimeFilterOpts,
): Promise<MatchingPartTimeRow[]> {
    const matches: MatchingPartTimeRow[] = [];
    const columns = opts.roleQuery.terms.length > 0 ? 'id, title' : 'id';
    let from = 0;
    for (;;) {
        let query = db.from(PART_TIME_JOBS_TABLE).select(columns);
        query = applyPartTimeFilters(query, opts);
        const { data, error } = await query
            .order('id', { ascending: true })
            .range(from, from + ID_FETCH_BATCH - 1);

        if (error) {
            throw new Error(error.message);
        }

        const rows = ((data as unknown) as MatchingPartTimeRow[] | null) || [];
        matches.push(...rows);
        if (rows.length < ID_FETCH_BATCH) break;
        from += ID_FETCH_BATCH;
    }
    return matches;
}

/** Best relevance tier first; shuffled within each tier so repeat searches stay stable. */
function orderPartTimeMatches(
    rows: MatchingPartTimeRow[],
    roleQuery: PartTimeRoleQuery,
    shuffleSeed: string,
): string[] {
    const ids = rows.map((row) => String(row.id));
    if (roleQuery.terms.length === 0) return sortIdsBySeed(ids, shuffleSeed);

    const rank = createPartTimeRoleRanker(roleQuery);
    const tiers: string[][] = [];
    for (const row of rows) {
        const tier = rank(typeof row.title === 'string' ? row.title : '');
        (tiers[tier] ??= []).push(String(row.id));
    }
    return tiers.flatMap((tierIds, tier) =>
        tierIds ? sortIdsBySeed(tierIds, `${shuffleSeed}:tier${tier}`) : [],
    );
}

async function resolveShuffledPartTimeIds(
    db: SupabaseClient,
    opts: PartTimeFilterOpts,
    shuffleSeed: string,
): Promise<string[]> {
    const cacheKey = buildPartTimeFeedOrderCacheKey(
        shuffleSeed,
        partTimeFilterFingerprint(opts),
        await getJobsCatalogVersion(),
    );

    const cached = await getCachedPartTimeFeedOrder(cacheKey);
    if (cached) return cached;

    const noEmployerMatched =
        Boolean(opts.companyIlike) &&
        opts.companyIds.length === 0 &&
        opts.partTimeCompanyIds.length === 0;
    if (noEmployerMatched) return [];

    const rows = await fetchMatchingPartTimeRows(db, opts);
    const ordered = orderPartTimeMatches(rows, opts.roleQuery, shuffleSeed);
    const isTextSearch = opts.roleQuery.terms.length > 0 || Boolean(opts.companyIlike);
    await setCachedPartTimeFeedOrder(
        cacheKey,
        ordered,
        isTextSearch ? PART_TIME_SEARCH_ORDER_TTL_SECONDS : undefined,
    );
    return ordered;
}

async function fetchPartTimeRowsByIds(
    db: SupabaseClient,
    orderedIds: string[],
): Promise<Record<string, unknown>[]> {
    if (orderedIds.length === 0) return [];
    const rows = await selectByIds(db, PART_TIME_JOBS_TABLE, LIST_COLUMNS, orderedIds);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    return orderedIds.map((id) => byId.get(id)).filter((row): row is Record<string, unknown> => !!row);
}

export async function getPartTimeJobsFeed(params: {
    page: number;
    role?: string;
    company?: string;
    city?: string;
    userId?: string;
    maxJobsReturned?: number;
    /** Page size; defaults to JOBS_PAGE_SIZE (logged-in feed). The public preview passes its own cap. */
    limit?: number;
}): Promise<PartTimeJobsFeedResult> {
    const db = getSupabaseAdmin();
    const page = Math.max(1, params.page || 1);
    const limit = params.limit ?? JOBS_PAGE_SIZE;
    const roleQuery = parsePartTimeRoleQuery(params.role);
    const companyTerm = normalizeSearchTerm(params.company || '');
    const companyIlike = ilikeTerm(companyTerm);

    const employerIds = companyIlike
        ? await matchingEmployerIds(db, companyTerm)
        : { companyIds: [], partTimeCompanyIds: [] };

    const filterOpts: PartTimeFilterOpts = {
        roleQuery,
        companyIlike,
        city: params.city,
        companyIds: employerIds.companyIds,
        partTimeCompanyIds: employerIds.partTimeCompanyIds,
    };

    const shuffleSeed = derivePartTimeShuffleSeed(params.userId || 'anon', {
        city: params.city,
        role: params.role,
        where: params.company,
    });

    const [orderedIds, globalTotalCount] = await Promise.all([
        resolveShuffledPartTimeIds(db, filterOpts, shuffleSeed),
        globalJobCount(db),
    ]);

    const totalCount = orderedIds.length;
    const from = (page - 1) * limit;
    const pageIds = orderedIds.slice(from, from + limit);
    const pageRows = await fetchPartTimeRowsByIds(db, pageIds);

    let jobs = await hydratePartTimeJobs(db, pageRows);
    jobs = await attachReportedFlags(db, jobs, params.userId);

    if (params.maxJobsReturned !== undefined) {
        jobs = jobs.slice(0, params.maxJobsReturned);
    }

    return {
        jobs,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
        totalCount,
        globalTotalCount,
    };
}

export async function getPartTimeJobById(
    jobId: string,
    userId?: string,
): Promise<JobsPortalJob | null> {
    const db = getSupabaseAdmin();
    const { data, error } = await db
        .from(PART_TIME_JOBS_TABLE)
        .select(LIST_COLUMNS)
        .eq('id', jobId)
        .maybeSingle();

    if (error) {
        console.error('[partTimeFeed] job fetch error:', error.message);
        return null;
    }
    if (!data) return null;

    const [job] = await hydratePartTimeJobs(db, [data as Record<string, unknown>]);
    if (!job) return null;
    const [withReport] = await attachReportedFlags(db, [job], userId);
    return withReport ?? job;
}
