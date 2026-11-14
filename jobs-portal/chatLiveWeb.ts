import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { fetchEmployerBoardJobs, parseEmployerBoardUrl, type EmployerBoard } from './chatEmployerSources';
import type { ChatSearch } from './chatIntent';
import { chatCivilServiceEvidence, chatTextContains } from './chatMatching';
import { jobsTableForCountry, type JobsCatalogCountry } from './jobsCatalog';
import { PORTAL_COMPANY_COLUMNS, toPublicPortalCompany } from './publicResponse';
import type { JobsPortalJob } from './types';
import { createChatCatalogueReadOnlyFetch } from './chatCatalogue';

const MAX_COMPANIES = 100;
const MAX_SEEDS = 200;
const MAX_BOARDS = 6;
const CONCURRENCY = 3;
const OPTIONAL_COLUMNS = ['ats_provider', 'ats_board_token', 'careers_url', 'ireland_permit_employer'];
const COMPANY_COLUMNS = `${PORTAL_COMPANY_COLUMNS}, ats_provider, ats_board_token`;

export interface ChatLiveWebDependencies {
    signal?: AbortSignal;
    /** Tests inject a mock; the production client permits SELECT requests only. */
    client?: SupabaseClient;
    fetchBoard?: typeof fetchEmployerBoardJobs;
    now?: () => number;
    /** Trusted server observer for transient, exact-source continuation references. */
    onBoardJobs?: (board: EmployerBoard, jobs: JobsPortalJob[]) => void;
    /** Boards read per search (default 6, at most 12); a caller with its own deadline may read more. */
    maxBoards?: number;
}

export interface ChatLiveWebResult {
    jobs: JobsPortalJob[];
    examined: number;
    excluded: number;
    retrievedAt: string;
    cacheHit: false;
    /** Attempted board reads; boardsFailed is a subset. */
    boardsChecked: number;
    boardsFailed: number;
    /** Supported unique boards found within the bounded discovery reads. */
    boardsAvailable: number;
    limitReached: boolean;
}

export class ChatLiveWebError extends Error {
    constructor(readonly code: 'NOT_CONFIGURED' | 'UNAVAILABLE') {
        super('Live employer-site search is unavailable. CAFY catalogue jobs remain available.');
        this.name = 'ChatLiveWebError';
    }
}

function readOnlyClient(signal?: AbortSignal): SupabaseClient {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) throw new ChatLiveWebError('NOT_CONFIGURED');
    return createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: createChatCatalogueReadOnlyFetch({ signal }) },
    });
}

function tokens(value: string): string[] {
    return [
        ...new Set(
            value
                .toLowerCase()
                .replace(/['\u2018\u2019]/g, '')
                .match(/[a-z0-9]+/g) || [],
        ),
    ];
}
function safeName(value: unknown): string {
    return typeof value === 'string' && value.trim().length <= 200 ? value.trim() : '';
}
function numericId(value: unknown): number | undefined {
    const parsed =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && /^[1-9]\d*$/.test(value)
              ? Number(value)
              : undefined;
    return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

interface CompanyDiscovery {
    rows: Record<string, unknown>[];
    limitReached: boolean;
}

async function companyRows(
    db: SupabaseClient,
    criteria: { employer?: string; ids?: number[]; pool?: boolean },
): Promise<CompanyDiscovery> {
    let columns = COMPANY_COLUMNS.split(',').map((column) => column.trim());
    for (let attempt = 0; attempt <= OPTIONAL_COLUMNS.length; attempt++) {
        let query = db.from('companies').select(columns.join(', '));
        for (const token of tokens(criteria.employer || '')) {
            query = query.or(`trading_name.ilike.%${token}%,companies_house_name.ilike.%${token}%`);
        }
        if (criteria.ids) query = query.in('id', criteria.ids);
        if (criteria.pool) {
            const filters: string[] = [];
            if (columns.includes('ats_provider')) filters.push('ats_provider.in.(greenhouse,lever,ashby,ashbyhq)');
            for (const column of ['careers_url', 'url', 'ats_board_token'].filter((name) => columns.includes(name))) {
                for (const host of ['greenhouse.io', 'lever.co', 'ashbyhq.com'])
                    filters.push(`${column}.ilike.%${host}%`);
            }
            if (!filters.length) return { rows: [], limitReached: false };
            query = query.or(filters.join(','));
        }
        const response = await query.order('id', { ascending: true }).limit(MAX_COMPANIES + 1);
        if (!response.error) {
            const rows = (response.data || []) as unknown as Record<string, unknown>[];
            return {
                rows: rows
                    .slice(0, MAX_COMPANIES)
                    .filter(
                        (row) =>
                            !criteria.employer ||
                            [row.trading_name, row.companies_house_name].some(
                                (name) => typeof name === 'string' && chatTextContains(name, criteria.employer!),
                            ),
                    ),
                limitReached: rows.length > MAX_COMPANIES,
            };
        }
        const missing = OPTIONAL_COLUMNS.find(
            (column) => columns.includes(column) && new RegExp(`\\b${column}\\b`, 'i').test(response.error!.message),
        );
        if (!missing || !['42703', 'PGRST204'].includes(response.error.code || ''))
            throw new ChatLiveWebError('UNAVAILABLE');
        columns = columns.filter((column) => column !== missing);
    }
    throw new ChatLiveWebError('UNAVAILABLE');
}

async function seedEmployerIds(
    db: SupabaseClient,
    search: ChatSearch,
    country: JobsCatalogCountry,
): Promise<{ ids: number[]; limitReached: boolean }> {
    const table = search.kind === 'part-time' ? 'part_time_jobs_UK' : jobsTableForCountry(country);
    let query = db.from(table).select('company_id', { count: 'exact' });
    for (const token of tokens(search.role)) query = query.or(`title.ilike.%${token}%,department.ilike.%${token}%`);
    const response = await query.order('created_at', { ascending: false }).limit(MAX_SEEDS + 1);
    if (response.error) throw new ChatLiveWebError('UNAVAILABLE');
    const rows = (response.data || []) as unknown as Array<{ company_id?: unknown }>;
    return {
        ids: [
            ...new Set(
                rows
                    .slice(0, MAX_SEEDS)
                    .map((row) => numericId(row.company_id))
                    .filter((id): id is number => id !== undefined),
            ),
        ],
        limitReached: rows.length > MAX_SEEDS || (typeof response.count === 'number' && response.count > MAX_SEEDS),
    };
}

/** Sources are existing employer configuration or actual ATS URLs in that employer's catalogue row. */
function boardFromCompany(row: Record<string, unknown>, country: JobsCatalogCountry): EmployerBoard | null {
    const name = safeName(row.trading_name);
    if (!name || numericId(row.id) === undefined) return null;
    const parsedUrls = [row.careers_url, row.url, row.ats_board_token]
        .filter((value): value is string => typeof value === 'string')
        .map(parseEmployerBoardUrl)
        .filter((value): value is EmployerBoard => Boolean(value));
    const providerText = typeof row.ats_provider === 'string' ? row.ats_provider.trim().toLowerCase() : '';
    const provider = providerText === 'ashbyhq' ? 'ashby' : providerText;
    const token = typeof row.ats_board_token === 'string' ? row.ats_board_token.trim() : '';
    let board = parsedUrls[0];
    if (['greenhouse', 'lever', 'ashby'].includes(provider) && /^[a-zA-Z0-9_-]{1,150}$/.test(token)) {
        const matchingUrl = parsedUrls.find((value) => value.provider === provider && value.token === token);
        board = { provider: provider as EmployerBoard['provider'], token, region: matchingUrl?.region || 'global' };
    }
    if (!board) return null;
    const company = toPublicPortalCompany(row);
    return {
        ...board,
        name,
        ...(typeof row.url === 'string' ? { website: row.url } : {}),
        company: country === 'ireland' ? { ...company, licensed_sponsor: false } : company,
    };
}

/** Re-read an established employer identity using SELECT only; no guessed board names. */
export async function readChatEmployerBoard(
    companyId: number,
    country: JobsCatalogCountry,
    deps: Pick<ChatLiveWebDependencies, 'client' | 'signal'> = {},
): Promise<EmployerBoard | null> {
    if (!Number.isSafeInteger(companyId) || companyId <= 0 || !['uk', 'ireland'].includes(country))
        throw new ChatLiveWebError('UNAVAILABLE');
    if (deps.signal?.aborted) throw new ChatLiveWebError('UNAVAILABLE');
    const found = await companyRows(deps.client || readOnlyClient(deps.signal), { ids: [companyId] });
    const matching = found.rows.filter((row) => numericId(row.id) === companyId);
    return matching.length === 1 ? boardFromCompany(matching[0]!, country) : null;
}

function uniqueBoards(rows: Record<string, unknown>[], country: JobsCatalogCountry, search: ChatSearch): EmployerBoard[] {
    const seen = new Set<string>();
    return rows.flatMap((row) => {
        // A generic ATS board is not evidence that its employer is in the Civil
        // Service. Keep this scope before public requests as well as at matching.
        if (
            search.employerScope === 'civil-service' &&
            !chatCivilServiceEvidence({ url: '', company: toPublicPortalCompany(row) })
        )
            return [];
        const board = boardFromCompany(row, country);
        if (!board) return [];
        const key = `${board.provider}:${board.region || 'global'}:${board.token}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [board];
    });
}

/**
 * Reads independently discovered catalogue employer boards. No Google-grounding
 * URLs, credentials, job ingestion, account mutation or shared cache is involved.
 */
export async function searchChatEmployerWebJobs(
    search: ChatSearch,
    country: JobsCatalogCountry,
    deps: ChatLiveWebDependencies = {},
): Promise<ChatLiveWebResult> {
    if (search.kind === 'part-time' && country !== 'uk') throw new ChatLiveWebError('UNAVAILABLE');
    if (deps.signal?.aborted) throw new ChatLiveWebError('UNAVAILABLE');
    const db = deps.client || readOnlyClient(deps.signal);
    const retrievedAt = new Date((deps.now || Date.now)()).toISOString();
    const maxBoards = Math.min(12, Math.max(1, Math.floor(deps.maxBoards ?? MAX_BOARDS)));
    let candidates: CompanyDiscovery;
    let seedLimit = false;
    if (search.employer) {
        candidates = await companyRows(db, { employer: search.employer });
    } else if (search.role) {
        const seeds = await seedEmployerIds(db, search, country);
        seedLimit = seeds.limitReached;
        candidates = seeds.ids.length ? await companyRows(db, { ids: seeds.ids }) : { rows: [], limitReached: false };
    } else {
        candidates = { rows: [], limitReached: false };
    }
    let boards = uniqueBoards(candidates.rows, country, search);
    let discoveryLimit = candidates.limitReached;
    if (!boards.length && !search.employer) {
        const pool = await companyRows(db, { pool: true });
        boards = uniqueBoards(pool.rows, country, search);
        discoveryLimit ||= pool.limitReached;
    }
    const result: ChatLiveWebResult = {
        jobs: [],
        examined: 0,
        excluded: 0,
        retrievedAt,
        cacheHit: false,
        boardsChecked: 0,
        boardsFailed: 0,
        boardsAvailable: boards.length,
        limitReached: seedLimit || discoveryLimit || boards.length > maxBoards,
    };
    if (deps.signal?.aborted) throw new ChatLiveWebError('UNAVAILABLE');
    const selected = boards.slice(0, maxBoards);
    const fetchBoard = deps.fetchBoard || fetchEmployerBoardJobs;
    let next = 0;
    const observations = new Array<Awaited<ReturnType<typeof fetchEmployerBoardJobs>> | null>(selected.length).fill(
        null,
    );
    await Promise.all(
        Array.from({ length: Math.min(maxBoards > MAX_BOARDS ? 4 : CONCURRENCY, selected.length) }, async () => {
            while (next < selected.length && !deps.signal?.aborted) {
                const index = next++;
                result.boardsChecked++;
                try {
                    observations[index] = await fetchBoard(selected[index]!, country, { signal: deps.signal });
                    deps.onBoardJobs?.(selected[index]!, observations[index]!.jobs);
                } catch {
                    result.boardsFailed++;
                    result.limitReached = true;
                }
            }
        }),
    );
    if (deps.signal?.aborted) throw new ChatLiveWebError('UNAVAILABLE');
    if (result.boardsChecked && result.boardsFailed === result.boardsChecked) throw new ChatLiveWebError('UNAVAILABLE');
    const seen = new Set<string>();
    for (const observation of observations) {
        if (!observation) continue;
        result.examined += observation.examined;
        result.excluded += observation.excluded;
        result.limitReached ||= observation.limitReached;
        for (const job of observation.jobs) {
            if (seen.has(job.id)) {
                result.excluded++;
                continue;
            }
            seen.add(job.id);
            result.jobs.push(job);
        }
    }
    return result;
}
