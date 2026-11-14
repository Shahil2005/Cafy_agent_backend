import { createHash } from 'crypto';
import type { BrowseFilterOpts } from './feedOrderCache';
import { buildBrowseFilterHash } from './feedOrderCache';
import { getJobsPortalRedis } from './redisClient';
import { normalizeSearchTerm } from './feedSeed';
import type { JobsCatalogCountry } from './jobsCatalog';
import { jobsCatalogCacheSegment } from './jobsCatalog';

export const SEARCH_PAGE_CACHE_TTL_SECONDS = 1_800; // 30 min
export const SEARCH_COUNT_CACHE_TTL_SECONDS = 900; // 15 min

export interface CachedSearchPage {
    v: 1;
    jobIds: string[];
}

export function buildSearchQueryHash(roleTerm: string, whereTerm: string): string {
    const role = normalizeSearchTerm(roleTerm);
    const where = normalizeSearchTerm(whereTerm);
    return createHash('sha256').update(`role=${role}|where=${where}`).digest('hex').slice(0, 16);
}

export function buildSearchPageCacheKey(
    catalogVersion: number,
    queryHash: string,
    filterHash: string,
    page: number,
    catalogCountry: JobsCatalogCountry = 'uk'
): string {
    return `jobs-search:v7:${jobsCatalogCacheSegment(catalogCountry)}:${catalogVersion}:${queryHash}:${filterHash}:p${page}`;
}

export function buildSearchCountCacheKey(
    catalogVersion: number,
    queryHash: string,
    filterHash: string,
    catalogCountry: JobsCatalogCountry = 'uk'
): string {
    return `jobs-search:v7:${jobsCatalogCacheSegment(catalogCountry)}:${catalogVersion}:${queryHash}:${filterHash}:count`;
}

export function buildSearchCacheHashes(
    roleTerm: string,
    whereTerm: string,
    filterOpts: BrowseFilterOpts,
    searchPrefs?: {
        sectors?: string[] | null;
        jobLevels?: string[] | null;
        jobTypes?: string[] | null;
        matchingCompanyIds?: number[];
    }
): {
    queryHash: string;
    filterHash: string;
} {
    const sectors = (searchPrefs?.sectors ?? []).slice().sort().join(',');
    const levels = (searchPrefs?.jobLevels ?? []).slice().sort().join(',');
    const jobTypes = (searchPrefs?.jobTypes ?? []).slice().sort().join(',');
    const companies = (searchPrefs?.matchingCompanyIds ?? [])
        .slice()
        .sort((a, b) => a - b)
        .join(',');
    const prefsPayload = [sectors, levels, jobTypes, companies].join('|');
    const base = buildBrowseFilterHash(filterOpts);
    const filterHash = createHash('sha256')
        .update(`${base}|pref-rank-v7|${prefsPayload}`)
        .digest('hex')
        .slice(0, 16);
    return {
        queryHash: buildSearchQueryHash(roleTerm, whereTerm),
        filterHash,
    };
}

export async function getCachedSearchPage(cacheKey: string): Promise<string[] | null> {
    const redis = getJobsPortalRedis();
    if (!redis) return null;

    try {
        const raw = await redis.get<CachedSearchPage | string>(cacheKey);
        if (!raw) return null;

        const parsed: CachedSearchPage =
            typeof raw === 'string' ? (JSON.parse(raw) as CachedSearchPage) : raw;

        if (parsed.v !== 1 || !Array.isArray(parsed.jobIds)) {
            return null;
        }

        return parsed.jobIds.map(String);
    } catch (err) {
        console.warn('[jobs-search] Page cache read failed:', err);
        return null;
    }
}

export async function setCachedSearchPage(cacheKey: string, jobIds: string[]): Promise<void> {
    const redis = getJobsPortalRedis();
    if (!redis) return;

    const payload: CachedSearchPage = { v: 1, jobIds };

    try {
        await redis.set(cacheKey, payload, { ex: SEARCH_PAGE_CACHE_TTL_SECONDS });
    } catch (err) {
        console.warn('[jobs-search] Page cache write failed:', err);
    }
}

export async function getCachedSearchCount(cacheKey: string): Promise<number | null> {
    const redis = getJobsPortalRedis();
    if (!redis) return null;

    try {
        const cached = await redis.get<number>(cacheKey);
        if (typeof cached === 'number' && Number.isFinite(cached) && cached >= 0) {
            return cached;
        }
        return null;
    } catch (err) {
        console.warn('[jobs-search] Count cache read failed:', err);
        return null;
    }
}

export async function setCachedSearchCount(cacheKey: string, count: number): Promise<void> {
    const redis = getJobsPortalRedis();
    if (!redis) return;

    try {
        await redis.set(cacheKey, count, { ex: SEARCH_COUNT_CACHE_TTL_SECONDS });
    } catch (err) {
        console.warn('[jobs-search] Count cache write failed:', err);
    }
}
