import { JOB_CATALOG_LEVELS, type ExperienceLevel } from './constants';

const CATALOG_LEVEL_SET = new Set<string>(JOB_CATALOG_LEVELS);

/**
 * Collapse legacy profile / filter labels → production 4-level taxonomy.
 * Mirrors CAFY-JOBS `LEGACY_LEVEL_MAP` plus old Product filter buckets.
 */
const LEGACY_TO_CATALOG: Record<string, ExperienceLevel> = {
    Internship: 'Entry Level',
    Graduate: 'Entry Level',
    'Entry Level': 'Entry Level',
    'Entry-level': 'Entry Level',
    Entry: 'Entry Level',
    Junior: 'Junior',
    'Mid-level': 'Mid Level',
    'Mid Level': 'Mid Level',
    Mid: 'Mid Level',
    Senior: 'Senior',
    'Senior Level': 'Senior',
    Staff: 'Senior',
    Lead: 'Senior',
    Principal: 'Senior',
    Director: 'Senior',
    VP: 'Senior',
    Executive: 'Senior',
    Leadership: 'Senior',
    Manager: 'Senior',
};

const ACCEPTED_PROFILE_LEVEL_SET = new Set<string>([
    ...JOB_CATALOG_LEVELS,
    ...Object.keys(LEGACY_TO_CATALOG),
]);

function mapToCatalogLevel(raw: string): ExperienceLevel | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (CATALOG_LEVEL_SET.has(trimmed)) return trimmed as ExperienceLevel;
    return LEGACY_TO_CATALOG[trimmed] ?? null;
}

export function sanitizeUserExperienceLevels(
    input: string[] | undefined | null
): ExperienceLevel[] {
    if (!input?.length) return [];
    const seen = new Set<ExperienceLevel>();
    const out: ExperienceLevel[] = [];
    for (const raw of input) {
        const level = mapToCatalogLevel(String(raw));
        if (!level || seen.has(level)) continue;
        seen.add(level);
        out.push(level);
    }
    return out;
}

/** Profile values accepted for shuffle seeding (catalog + legacy → remapped on expand). */
export function sanitizeProfileExperienceLevels(input: string[] | undefined | null): string[] {
    if (!input?.length) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of input) {
        const trimmed = String(raw).trim();
        if (!ACCEPTED_PROFILE_LEVEL_SET.has(trimmed) || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

/** Map profile selections → `jobs.level` values for Supabase queries. */
export function expandUserLevelsToJobLevels(userLevels: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const userLevel of userLevels) {
        const level = mapToCatalogLevel(userLevel);
        if (!level || seen.has(level)) continue;
        seen.add(level);
        out.push(level);
    }

    return out;
}

export function normalizeJobCatalogLevel(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    return mapToCatalogLevel(raw);
}

/** PostgREST `not.in` list for level.is.null OR level not in matched set. */
export function buildLevelSectorOnlyOrClause(jobLevels: readonly string[]): string | null {
    if (!jobLevels.length) return null;
    const quoted = jobLevels.map((level) => `"${level.replace(/"/g, '')}"`).join(',');
    return `level.is.null,level.not.in.(${quoted})`;
}
