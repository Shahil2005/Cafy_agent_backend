/**
 * Jobs catalog country routing.
 *
 * UK listings live in `jobs`; Ireland listings live in `jobs_IR` (ingested by CAFY-JOBS).
 * Career preference `locations` selects which catalog the portal serves.
 */

export type JobsCatalogCountry = 'uk' | 'ireland';

/** Supabase table names — must match PostgREST-exposed relations. */
export type JobsTableName = 'jobs' | 'jobs_IR' | 'sponsorship_jobs' | 'quality_jobs' | 'quality_sponsorship_jobs';

export function isQualityUkCatalogue(): boolean {
    const mode = process.env.UK_JOB_CATALOGUE_MODE?.trim() || 'legacy';
    if (!['legacy', 'quality'].includes(mode)) throw new Error('UK_JOB_CATALOGUE_MODE must be legacy or quality');
    return mode === 'quality';
}

export function requiresFreshUkFeed(country: JobsCatalogCountry): boolean {
    return country === 'uk' && (isQualityUkCatalogue() || isStrictUkSponsorshipFeed());
}

export function isStrictUkSponsorshipFeed(): boolean {
    const mode = process.env.UK_SPONSORSHIP_FEED_MODE?.trim() || 'off';
    if (mode !== 'off' && mode !== 'strict') throw new Error('UK_SPONSORSHIP_FEED_MODE must be off or strict');
    return mode === 'strict';
}

export const JOBS_TABLE_UK: JobsTableName = 'jobs';
export const JOBS_TABLE_IRELAND: JobsTableName = 'jobs_IR';

function normalizeLocation(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Resolve catalog country from Firestore `preferences.locations`.
 * Mirrors Product-Site `isIrelandCareerLocation` / `resolveTargetCountryId`.
 * Defaults to UK when unset or unrecognized (safe for legacy profiles).
 */
export function resolveJobsCatalogCountry(
    locations: string[] | null | undefined
): JobsCatalogCountry {
    if (!locations?.length) return 'uk';

    for (const loc of locations) {
        const normalized = normalizeLocation(loc);
        if (!normalized) continue;

        if (normalized === 'united kingdom' || normalized === 'uk' || normalized === 'u.k.') {
            return 'uk';
        }
        if (normalized === 'ireland' || normalized === 'republic of ireland') {
            return 'ireland';
        }
        if (normalized === 'éire' || normalized === 'eire') {
            return 'ireland';
        }
    }

    // Legacy free-text: Ireland phrases, but never Northern Ireland alone as Ireland catalog
    for (const loc of locations) {
        const normalized = normalizeLocation(loc);
        if (!normalized) continue;
        if (normalized.includes('northern ireland')) continue;
        if (/\bireland\b/i.test(normalized)) return 'ireland';
    }

    return 'uk';
}

export function jobsTableForCountry(country: JobsCatalogCountry): JobsTableName {
    if (country === 'uk' && isQualityUkCatalogue()) return isStrictUkSponsorshipFeed() ? 'quality_sponsorship_jobs' : 'quality_jobs';
    return country === 'ireland' ? JOBS_TABLE_IRELAND : isStrictUkSponsorshipFeed() ? 'sponsorship_jobs' : JOBS_TABLE_UK;
}

export function isIrelandJobsCatalog(country: JobsCatalogCountry): boolean {
    return country === 'ireland';
}

/** Redis / cache namespace segment for a catalog. */
export function jobsCatalogCacheSegment(country: JobsCatalogCountry): string {
    if (country === 'uk' && isQualityUkCatalogue()) return isStrictUkSponsorshipFeed() ? 'uk-quality-sponsorship-v1' : 'uk-quality-v1';
    return country === 'uk' && isStrictUkSponsorshipFeed() ? 'uk-sponsorship-v1' : country;
}

/** Ranked search RPC names per catalog (with PostgREST ilike fallback if missing). */
export function searchJobsPageRpc(country: JobsCatalogCountry): string {
    if (country === 'uk' && isQualityUkCatalogue()) return isStrictUkSponsorshipFeed() ? 'search_quality_sponsorship_jobs_page' : 'search_quality_jobs_page';
    return country === 'ireland' ? 'search_jobs_ir_page' : isStrictUkSponsorshipFeed() ? 'search_sponsorship_jobs_page' : 'search_jobs_page';
}

export function searchJobsCountRpc(country: JobsCatalogCountry): string {
    if (country === 'uk' && isQualityUkCatalogue()) return isStrictUkSponsorshipFeed() ? 'search_quality_sponsorship_jobs_count' : 'search_quality_jobs_count';
    return country === 'ireland' ? 'search_jobs_ir_count' : isStrictUkSponsorshipFeed() ? 'search_sponsorship_jobs_count' : 'search_jobs_count';
}

const CATALOG_ALIASES: Record<string, JobsCatalogCountry> = {
    uk: 'uk',
    gb: 'uk',
    'united-kingdom': 'uk',
    'united kingdom': 'uk',
    ireland: 'ireland',
    ie: 'ireland',
    roi: 'ireland',
};

/** Parse `catalog=uk|ireland` query values. Returns null when absent or invalid. */
export function parseJobsCatalogCountry(raw: unknown): JobsCatalogCountry | null {
    if (typeof raw !== 'string') return null;
    const normalized = raw.trim().toLowerCase();
    if (!normalized) return null;
    return CATALOG_ALIASES[normalized] ?? null;
}

export function listPortalCompaniesRpc(includeRegister = false): string {
    return includeRegister ? 'list_portal_directory_companies' : 'list_portal_companies';
}

export function listPortalCompaniesCountRpc(includeRegister = false): string {
    return includeRegister
        ? 'list_portal_directory_companies_count'
        : 'list_portal_companies_count';
}
