import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { JOBS_PAGE_SIZE } from './constants';
import type { ChatSearch } from './chatIntent';
import { chatTextContains, matchChatJob } from './chatMatching';
import type { JobsFeedResult } from './entitlements';
import { jobsTableForCountry, type JobsCatalogCountry } from './jobsCatalog';
import { isLowProfilePortalJob } from './lowProfileJobs';
import {
    cleanPortalJobLocation,
    PORTAL_COMPANY_COLUMNS,
    portalJobChatColumns,
    toPublicPortalCompany,
    toPublicPortalJob,
} from './publicResponse';
import type { JobsPortalJob, PublicJobsPortalCompany } from './types';
import { ChatExecutionError, createChatExecution } from './chatExecution';

const BATCH_SIZE = 100;
const MAX_SCAN = 1000;
const MAX_EMPLOYERS = 200;
const PART_TIME_TABLE = 'part_time_jobs_UK';
const PART_TIME_COMPANIES = 'part_time_companies_UK';
const PART_TIME_COLUMNS =
    'id, title, url, location, city, nation, department, level, sector, job_type, created_at, company_id, part_time_company_id, description, salary';
const PART_TIME_COMPANY_COLUMNS =
    'id, trading_name, url, url_linkedin, url_favicon, description, estimated_num_employees_label';

export interface ChatCatalogueCoverage {
    /** Actual job rows checked, not an inferred catalogue size. */
    scanned: number;
    /** More candidates may exist because a scan or employer-lookup bound was reached. */
    limitReached: boolean;
    /** Candidate-only partial recovery: later failed batches, excluding unchecked rows from scanned. */
    sourceFailures?: number;
}

export interface ChatCatalogueResult extends JobsFeedResult {
    jobs: JobsPortalJob[];
    coverage: ChatCatalogueCoverage;
    evidence: Record<string, string[]>;
}

export interface ChatCatalogueDependencies {
    /** Test injection; production creates a client restricted to GET/HEAD requests. */
    client?: SupabaseClient;
    signal?: AbortSignal;
    /** Server-only retrieval budget for CV ranking; ordinary chat keeps its page limit. */
    candidateMode?: {
        maxJobs: number;
        maxScan: number;
        /** Trusted CV spelling prefilter; ordinary chat keeps the requested role. */
        roleQuery?: string;
        /** Exact career-title gate used after that broader spelling prefilter. */
        roleMatches?: (job: JobsPortalJob) => boolean;
        /** Server-owned quality/deduplication gate applied before filling the candidate budget. */
        accept?: (job: JobsPortalJob) => boolean;
    };
}

export type ChatCatalogueReadProfile = 'standard' | 'career-matching';

/** Server-owned transport policy; no request/search field selects a longer budget. */
export function chatCatalogueReadBudgetMs(options: { profile?: ChatCatalogueReadProfile; timeoutMs?: number } = {}): number {
    const maximum = options.profile === 'career-matching' ? 10_000 : 5000;
    const requested = options.timeoutMs ?? maximum;
    return Number.isFinite(requested) ? Math.max(0, Math.min(maximum, Math.floor(requested))) : maximum;
}

/** Bounded SELECT transport. Request, SDK and request-budget cancellation all reach the same fetch. */
export function createChatCatalogueReadOnlyFetch(
    options: {
        signal?: AbortSignal;
        fetch?: typeof globalThis.fetch;
        /** Trusted server code only: ordinary chat has five seconds; CV matching has ten. */
        profile?: ChatCatalogueReadProfile;
        /** Tests may shorten this; the selected server profile always supplies the hard ceiling. */
        timeoutMs?: number;
    } = {},
): typeof globalThis.fetch {
    return async (input, init) => {
        const method = (
            init?.method || (input instanceof Request ? input.method : 'GET')
        ).toUpperCase();
        if (method !== 'GET' && method !== 'HEAD')
            throw new Error(
                'Chat catalogue permits database SELECT requests only',
            );
        const controller = new AbortController();
        const parentSignals = [
            ...new Set(
                [
                    options.signal,
                    init?.signal,
                    input instanceof Request ? input.signal : undefined,
                ].filter((signal): signal is AbortSignal => Boolean(signal)),
            ),
        ];
        const onAbort = () => controller.abort();
        for (const signal of parentSignals) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        const budget = createChatExecution({
            signal: controller.signal,
            timeoutMs: chatCatalogueReadBudgetMs(options),
        });
        try {
            return await budget.run(async () => {
                const response = await (options.fetch || globalThis.fetch)(
                    input,
                    { ...init, signal: budget.signal },
                );
                // Keep the deadline active until the SELECT body is consumed;
                // a headers-only timeout would leave Supabase's JSON read unbounded.
                if (
                    method === 'HEAD' ||
                    [204, 205, 304].includes(response.status)
                )
                    return response;
                const limit = 8 * 1024 * 1024;
                if (Number(response.headers.get('content-length')) > limit) {
                    void response.body?.cancel().catch(() => undefined);
                    throw new Error('Chat catalogue response is too large');
                }
                const chunks: Uint8Array[] = [];
                let length = 0;
                const reader = response.body?.getReader();
                if (reader) {
                    const cancelReader = () => {
                        void reader.cancel().catch(() => undefined);
                    };
                    if (budget.signal.aborted) cancelReader();
                    else
                        budget.signal.addEventListener('abort', cancelReader, {
                            once: true,
                        });
                    try {
                        while (true) {
                            const chunk = await reader.read();
                            if (chunk.done) break;
                            length += chunk.value.byteLength;
                            if (length > limit) {
                                await reader.cancel().catch(() => undefined);
                                throw new Error(
                                    'Chat catalogue response is too large',
                                );
                            }
                            chunks.push(chunk.value);
                        }
                    } finally {
                        budget.signal.removeEventListener(
                            'abort',
                            cancelReader,
                        );
                        reader.releaseLock();
                    }
                }
                const headers = new Headers(response.headers);
                // Node fetch has already decoded the original response stream.
                headers.delete('content-encoding');
                headers.delete('content-length');
                return new Response(Buffer.concat(chunks), {
                    status: response.status,
                    statusText: response.statusText,
                    headers,
                });
            });
        } finally {
            budget.cleanup();
            for (const signal of parentSignals)
                signal.removeEventListener('abort', onAbort);
        }
    };
}

function readOnlyClient(signal?: AbortSignal, profile: ChatCatalogueReadProfile = 'standard'): SupabaseClient {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key)
        throw new Error('Chat catalogue database configuration is unavailable');
    return createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
            fetch: createChatCatalogueReadOnlyFetch({ signal, profile }),
        },
    });
}

/** Safe broad SQL candidate terms; exact boundaries are checked again after retrieval. */
function queryTerms(value: string): string[] {
    return [
        ...new Set(
            (
                value
                    .toLowerCase()
                    .replace(/['\u2018\u2019]/g, '')
                    .match(/c\+\+|c#|\.net|[a-z0-9]+/g) || []
            ).map((term) =>
                term.length > 4 && /[^s]s$/.test(term)
                    ? term.slice(0, -1)
                    : term,
            ),
        ),
    ];
}

function likeToken(value: string): string {
    // All values originate in queryTerms; dot in .NET has no PostgREST significance inside a value.
    return value.replace(/[^a-z0-9+#]/gi, '');
}

interface EmployerMatches {
    companyIds: number[];
    partTimeCompanyIds: number[];
    truncated: boolean;
}

async function lookupEmployerRelation(
    db: SupabaseClient,
    relation: string,
    employer: string,
): Promise<{ ids: number[]; truncated: boolean }> {
    const sponsorRelation = relation === 'companies';
    let query = db
        .from(relation)
        .select(
            sponsorRelation
                ? 'id, trading_name, companies_house_name'
                : 'id, trading_name',
        );
    const tokens = queryTerms(employer);
    if (!tokens.length) return { ids: [], truncated: false };
    for (const token of tokens) {
        const value = likeToken(token);
        query = query.or(
            `trading_name.ilike.%${value}%${sponsorRelation ? `,companies_house_name.ilike.%${value}%` : ''}`,
        );
    }
    const { data, error } = await query
        .order('id', { ascending: true })
        .limit(MAX_EMPLOYERS + 1);
    if (error) throw new Error('Chat catalogue employer lookup is unavailable');
    const rows = (data || []) as Array<{
        id?: unknown;
        trading_name?: unknown;
        companies_house_name?: unknown;
    }>;
    return {
        ids: rows
            .slice(0, MAX_EMPLOYERS)
            .filter((row) =>
                [row.trading_name, row.companies_house_name].some(
                    (name) =>
                        typeof name === 'string' &&
                        chatTextContains(name, employer),
                ),
            )
            .map((row) => Number(row.id))
            .filter((id) => Number.isFinite(id) && id > 0),
        truncated: rows.length > MAX_EMPLOYERS,
    };
}

async function lookupEmployers(
    db: SupabaseClient,
    search: ChatSearch,
): Promise<EmployerMatches> {
    if (!search.employer)
        return { companyIds: [], partTimeCompanyIds: [], truncated: false };
    const [companies, partTime] = await Promise.all([
        lookupEmployerRelation(db, 'companies', search.employer),
        search.kind === 'part-time'
            ? lookupEmployerRelation(db, PART_TIME_COMPANIES, search.employer)
            : Promise.resolve({ ids: [], truncated: false }),
    ]);
    return {
        companyIds: companies.ids,
        partTimeCompanyIds: partTime.ids,
        truncated: companies.truncated || partTime.truncated,
    };
}

export type ChatCatalogueFilter =
    | { kind: 'or'; value: string }
    | { kind: 'in'; column: string; values: string[] };

/** Independent dimensions are chained (AND); alternatives within a dimension use OR. */
export function chatCatalogueFilters(
    search: ChatSearch,
    employers: Pick<EmployerMatches, 'companyIds' | 'partTimeCompanyIds'>,
): ChatCatalogueFilter[] {
    const filters: ChatCatalogueFilter[] = [];
    for (const term of queryTerms(search.role)) {
        const token = likeToken(term);
        if (token)
            filters.push({
                kind: 'or',
                value: `title.ilike.%${token}%,department.ilike.%${token}%`,
            });
    }
    for (const term of queryTerms(search.where)) {
        const token = likeToken(term);
        if (token)
            filters.push({
                kind: 'or',
                value: `location.ilike.%${token}%${search.kind === 'part-time' ? `,city.ilike.%${token}%` : ''}`,
            });
    }
    if (search.employer) {
        const clauses = [
            employers.companyIds.length
                ? `company_id.in.(${employers.companyIds.join(',')})`
                : '',
            search.kind === 'part-time' && employers.partTimeCompanyIds.length
                ? `part_time_company_id.in.(${employers.partTimeCompanyIds.join(',')})`
                : '',
        ].filter(Boolean);
        if (clauses.length)
            filters.push({ kind: 'or', value: clauses.join(',') });
    }
    if (search.jobTypes.length)
        filters.push({
            kind: 'in',
            column: 'job_type',
            values: search.jobTypes,
        });
    if (search.levels.length)
        filters.push({ kind: 'in', column: 'level', values: search.levels });
    return filters;
}

async function hydratePartTimeRows(
    db: SupabaseClient,
    rows: Record<string, unknown>[],
): Promise<JobsPortalJob[]> {
    const companyIds = [
        ...new Set(
            rows
                .map((row) => Number(row.company_id))
                .filter((id) => Number.isFinite(id) && id > 0),
        ),
    ];
    const partTimeIds = [
        ...new Set(
            rows
                .map((row) => Number(row.part_time_company_id))
                .filter((id) => Number.isFinite(id) && id > 0),
        ),
    ];
    const [sponsors, partTimeResponse] = await Promise.all([
        selectCompaniesStrict(db, companyIds),
        partTimeIds.length
            ? db
                  .from(PART_TIME_COMPANIES)
                  .select(PART_TIME_COMPANY_COLUMNS)
                  .in('id', partTimeIds)
            : Promise.resolve({ data: [], error: null }),
    ]);
    if (partTimeResponse.error)
        throw new Error(
            'Chat catalogue part-time employer data is unavailable',
        );
    const sponsorMap = new Map(
        sponsors.map((company) => [company.id, company]),
    );
    const partTimeMap = new Map(
        ((partTimeResponse.data || []) as Record<string, unknown>[]).map(
            (row) => {
                const company = toPublicPortalCompany(row);
                return [company.id, company] as const;
            },
        ),
    );
    return rows.map((row) => {
        const company =
            sponsorMap.get(Number(row.company_id)) ||
            partTimeMap.get(Number(row.part_time_company_id));
        const location =
            cleanPortalJobLocation(row.location) ||
            (typeof row.city === 'string' ? row.city.trim() : '') ||
            (typeof row.nation === 'string' ? row.nation.trim() : '') ||
            'United Kingdom';
        return toPublicPortalJob({
            ...row,
            location,
            company_id: company?.id ?? row.company_id,
            ...(company ? { company } : {}),
        });
    });
}

/** Unlike legacy portal helpers, an unavailable employer query cannot become an empty successful search. */
async function selectCompaniesStrict(
    db: SupabaseClient,
    ids: number[],
): Promise<PublicJobsPortalCompany[]> {
    if (!ids.length) return [];
    let columns = PORTAL_COMPANY_COLUMNS;
    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await db
            .from('companies')
            .select(columns)
            .in('id', ids);
        if (!response.error)
            return (
                (response.data || []) as unknown as Record<string, unknown>[]
            ).map(toPublicPortalCompany);
        const missing = ['ireland_permit_employer', 'careers_url'].find(
            (column) =>
                new RegExp(`\\b${column}\\b`, 'i').test(
                    response.error!.message,
                ) &&
                columns.split(',').some((value) => value.trim() === column),
        );
        if (
            !missing ||
            !['42703', 'PGRST204'].includes(response.error.code || '')
        )
            throw new Error('Chat catalogue employer data is unavailable');
        columns = columns
            .split(',')
            .map((value) => value.trim())
            .filter((value) => value !== missing)
            .join(', ');
    }
    throw new Error('Chat catalogue employer data is unavailable');
}

async function hydrateCareerRows(
    db: SupabaseClient,
    rows: Record<string, unknown>[],
): Promise<JobsPortalJob[]> {
    const ids = [
        ...new Set(
            rows
                .map((row) => Number(row.company_id))
                .filter((id) => Number.isFinite(id) && id > 0),
        ),
    ];
    const companies = await selectCompaniesStrict(db, ids);
    const byId = new Map(companies.map((company) => [company.id, company]));
    // Preserve the portal's inner-join catalogue scope for orphaned employer IDs.
    return rows.flatMap((row) => {
        const company = byId.get(Number(row.company_id));
        return company ? [toPublicPortalJob({ ...row, company })] : [];
    });
}

function relevance(job: JobsPortalJob, search: ChatSearch): number {
    if (!search.role) return 0;
    return chatTextContains(job.title, search.role)
        ? 2
        : chatTextContains(`${job.title} ${job.department || ''}`, search.role)
          ? 1
          : 0;
}

function boundedBudget(value: number, maximum: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
}

function catalogueSelection(search: ChatSearch, country: JobsCatalogCountry): { table: string; columns: string } {
    const table = search.kind === 'part-time' ? PART_TIME_TABLE : jobsTableForCountry(country);
    let columns = search.kind === 'part-time' ? PART_TIME_COLUMNS : portalJobChatColumns(table, true);
    if (!columns.split(',').some((value) => value.trim() === 'salary')) columns += ', salary';
    return { table, columns };
}

/** Reload only an authenticated matching cursor's bounded identities; no search RPC or write transport. */
export async function reloadChatCatalogueCandidatesByIds(
    ids: string[],
    search: ChatSearch,
    country: JobsCatalogCountry,
    dependencies?: Pick<ChatCatalogueDependencies, 'client' | 'signal'>,
): Promise<JobsPortalJob[]> {
    if (
        !Array.isArray(ids) || ids.length > 120 ||
        ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))
    ) throw new Error('Invalid career candidate identities');
    if (country !== 'uk' && country !== 'ireland') throw new Error('Invalid catalogue country');
    if (search.kind === 'part-time' && country !== 'uk') throw new Error('Part-time catalogue is UK only');
    const assertActive = () => {
        if (dependencies?.signal?.aborted) throw new ChatExecutionError('cancelled');
    };
    assertActive();
    if (!ids.length || search.unsupported?.length) return [];
    const unique = [...new Set(ids)];
    const db = dependencies?.client || readOnlyClient(dependencies?.signal, 'career-matching');
    const selection = catalogueSelection(search, country);
    let columns = selection.columns;
    const read = () => db.from(selection.table).select(columns).in('id', unique).limit(unique.length);
    let response = await read();
    assertActive();
    if (
        response.error && /\bsalary\b/i.test(response.error.message) &&
        ['42703', 'PGRST204'].includes(response.error.code || '')
    ) {
        columns = columns.split(',').map((value) => value.trim()).filter((value) => value !== 'salary').join(', ');
        response = await read();
        assertActive();
    }
    if (response.error) throw new Error('Career candidate refresh is unavailable');
    const rows = (response.data || []) as unknown as Record<string, unknown>[];
    const jobs = search.kind === 'part-time'
        ? await hydratePartTimeRows(db, rows)
        : await hydrateCareerRows(db, rows);
    assertActive();
    const allowed = new Set(unique);
    const matches = new Map(
        jobs.filter((job) => allowed.has(job.id) &&
            !(search.kind === 'career' && isLowProfilePortalJob(job)) &&
            matchChatJob(job, search).matches,
        ).map((job) => [job.id, job]),
    );
    // Preserve the original ranking regardless of database row order or missing/deleted records.
    return unique.flatMap((id) => matches.has(id) ? [matches.get(id)!] : []);
}

/**
 * SELECT-only retrieval: no cached portal feeds, preference migration, usage logging,
 * search RPCs, tracker writes or database-maintenance helpers are called here.
 */
export async function searchChatCatalogue(
    search: ChatSearch,
    country: JobsCatalogCountry,
    maxJobsReturned?: number,
    dependencies?: ChatCatalogueDependencies,
): Promise<ChatCatalogueResult> {
    const assertActive = () => {
        if (dependencies?.signal?.aborted)
            throw new ChatExecutionError('cancelled');
    };
    assertActive();
    const empty = (
        coverage: ChatCatalogueCoverage = { scanned: 0, limitReached: false },
    ): ChatCatalogueResult => ({
        jobs: [],
        totalCount: 0,
        totalPages: 1,
        globalTotalCount: 0,
        evidence: {},
        coverage,
    });
    if (search.unsupported?.length) return empty();
    if (search.kind === 'part-time' && country !== 'uk')
        throw new Error('Part-time catalogue is UK only');
    const db = dependencies?.client || readOnlyClient(dependencies?.signal, dependencies?.candidateMode ? 'career-matching' : 'standard');
    const employers = await lookupEmployers(db, search);
    assertActive();
    if (
        search.employer &&
        !employers.companyIds.length &&
        !employers.partTimeCompanyIds.length
    ) {
        return empty({ scanned: 0, limitReached: employers.truncated });
    }
    const selection = catalogueSelection(search, country);
    const table = selection.table;
    let columns = selection.columns;
    const filters = chatCatalogueFilters(
        dependencies?.candidateMode?.roleQuery !== undefined
            ? { ...search, role: dependencies.candidateMode.roleQuery }
            : search,
        employers,
    );
    const pageCap = dependencies?.candidateMode
        ? boundedBudget(dependencies.candidateMode.maxJobs, 120)
        : Math.min(JOBS_PAGE_SIZE, Math.max(0, maxJobsReturned ?? JOBS_PAGE_SIZE));
    const scanCap = dependencies?.candidateMode
        ? boundedBudget(dependencies.candidateMode.maxScan, MAX_SCAN)
        : MAX_SCAN;
    if (!pageCap || !scanCap) return empty();
    const matches: Array<{ job: JobsPortalJob; evidence: string[] }> = [];
    let scanned = 0;
    let candidateCount: number | null = null;
    let exhausted = false;
    let sourceFailures = 0;
    for (let offset = 0; offset < scanCap; offset += BATCH_SIZE) {
        assertActive();
        const batchLimit = Math.min(BATCH_SIZE, scanCap - offset);
        const readPage = async () => {
            let query = db
                .from(table)
                .select(columns, offset === 0 && !dependencies?.candidateMode ? { count: 'exact' } : undefined);
            for (const filter of filters)
                query =
                    filter.kind === 'or'
                        ? query.or(filter.value)
                        : query.in(filter.column, filter.values);
            return query
                .order('created_at', { ascending: false })
                .order('id', { ascending: false })
                .range(offset, offset + batchLimit - 1);
        };
        try {
            let response = await readPage();
            assertActive();
            // Old catalogues may not expose salary; actual advert pay can still be checked.
            if (
                response.error &&
                /\bsalary\b/i.test(response.error.message) &&
                ['42703', 'PGRST204'].includes(response.error.code || '')
            ) {
                columns = columns
                    .split(',')
                    .map((value) => value.trim())
                    .filter((value) => value !== 'salary')
                    .join(', ');
                response = await readPage();
                assertActive();
            }
            if (response.error)
                throw new Error('Chat catalogue search is unavailable');
            if (offset === 0 && typeof response.count === 'number')
                candidateCount = response.count;
            const rows = (response.data || []) as unknown as Record<string, unknown>[];
            const jobs = search.kind === 'part-time'
                ? await hydratePartTimeRows(db, rows)
                : await hydrateCareerRows(db, rows);
            assertActive();
            const batchMatches: typeof matches = [];
            for (const job of jobs) {
                if (search.kind === 'career' && isLowProfilePortalJob(job)) continue;
                const match = matchChatJob(job, dependencies?.candidateMode?.roleMatches ? { ...search, role: '' } : search);
                if (match.matches && (!dependencies?.candidateMode?.roleMatches || dependencies.candidateMode.roleMatches(job)) &&
                    (!dependencies?.candidateMode?.accept || dependencies.candidateMode.accept(job)))
                    batchMatches.push({ job, evidence: match.evidence });
            }
            // A batch contributes coverage/results only after all employer evidence
            // and hard filters have been checked. Failed hydration is never a match.
            scanned += rows.length;
            matches.push(...batchMatches);
            exhausted = rows.length < batchLimit ||
                (candidateCount !== null && scanned >= candidateCount);
            if (exhausted || matches.length >= pageCap + 1) break;
        } catch (error) {
            // A caller cancellation/deadline must not publish late partial results.
            assertActive();
            if (!dependencies?.candidateMode || !matches.length ||
                (error instanceof ChatExecutionError && error.kind === 'cancelled')) throw error;
            // Keep only earlier completed eligible batches; ordinary chat retains
            // its original unavailable behavior and first-batch failures still fail.
            sourceFailures++;
            exhausted = false;
            break;
        }
    }
    matches.sort((a, b) => relevance(b.job, search) - relevance(a.job, search));
    const visible = matches.slice(0, pageCap);
    return {
        jobs: visible.map((value) => value.job),
        // This is an observed match count. coverage prevents callers presenting a
        // bounded/early-stopped scan as an exact catalogue-wide total.
        totalCount: matches.length,
        totalPages: Math.max(1, Math.ceil(matches.length / JOBS_PAGE_SIZE)),
        globalTotalCount: 0,
        evidence: Object.fromEntries(
            visible.map((value) => [value.job.id, value.evidence]),
        ),
        coverage: {
            scanned,
            limitReached: employers.truncated || !exhausted,
            ...(sourceFailures ? { sourceFailures } : {}),
        },
    };
}
